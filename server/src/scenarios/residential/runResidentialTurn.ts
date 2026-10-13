import { EngineTaskExecutionError } from '../../analysis/runtime/task';
import { residentialEvaluationIdentity } from './evaluationIdentity';
import fs from 'node:fs';
import path from 'node:path';
import { briefSunlightConfig, briefDaylightConfig, checkResidentialBrief, evaluateResidentialDaylight, roomDaylight, type ResidentialBriefDocument, type ResidentialDaylightEvaluation, type ResidentialDaylightRecord, type SpaceModel, type StreamEvent } from '@sdd/shared';
import type { ProviderAdapter, TurnResult } from '../../providers/types';
import { validateAgentModel } from '../../model/validateAgent';
import { validateModel } from '../../model/validate';
import { validateResidentialCandidate } from './residentialBrief';
import { parseResidentialStrategy, residentialStrategyPrompt } from './residentialStrategy';
import { solveResidentialLayout } from './residentialSolver';
import { ResidentialSolveError } from './residentialErrors';
import { boundedAgent, GenerationTimeout } from '../../generation/boundedAgent';
import { persistGeneration, registerGeneration, type GenerationState } from '../../generation/lifecycle';
import { DAYLIGHT_ENGINE_ID } from '../../daylight/run';
import { runResidentialDaylightPlan, residentialDaylightPlan } from './analysisPlan';

function daylightRank(evaluation:ResidentialDaylightEvaluation):[number,number,number,number] {
  const active=evaluation.rooms.filter(r=>r.enabled);
  return [active.filter(r=>r.status==='needs_review').length,
    evaluation.hardUnmetCount,evaluation.softUnmetCount,
    active.reduce((sum,r)=>sum+Math.max(0,r.requiredRatio-(r.actualRatio??0))*(r.priority==='hard'?2:1),0)];
}
function compareRank(a:number[],b:number[]):number {
  for(let i=0;i<a.length;i++)if(Math.abs(a[i]-b[i])>1e-8)return a[i]-b[i];
  return 0;
}

export async function runResidentialTurn(input:{cwd:string;revisionId:string;sessionId?:string;model?:string;residentialBrief:ResidentialBriefDocument;base:SpaceModel},adapter:ProviderAdapter,emit:(event:StreamEvent)=>void,signal?:AbortSignal,solve:typeof solveResidentialLayout=solveResidentialLayout):Promise<TurnResult> {
  const folder=path.join(input.cwd,'designs',input.revisionId);
  const agentCwd=path.join(folder,'agent');fs.mkdirSync(agentCwd,{recursive:true});
  const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(folder,name),JSON.stringify(value,null,2));
  write('generation-brief.json',input.residentialBrief);write('sunlight.json',briefSunlightConfig(input.residentialBrief.brief));write('daylight.json',briefDaylightConfig(input.residentialBrief.brief));
  write('analysis-plan.json',residentialDaylightPlan(briefDaylightConfig(input.residentialBrief.brief)));
  write('validation.json',{valid:false,status:'pending'});
  const controller=new AbortController();
  const cancel=()=>controller.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const state:GenerationState={status:'running',phase:'preflight',startedAt:new Date().toISOString(),updatedAt:'',ownerPid:process.pid,attempt:0,timings:[]};
  const unregister=registerGeneration(folder,controller,state);
  const phase=(value:string)=>{state.phase=value;persistGeneration(folder,state);};
  const taskDeadline=Date.now()+12*60*1000;
  const prompt=residentialStrategyPrompt(input.revisionId,input.residentialBrief.brief,input.base);
  let nativeSessionId:string|undefined,errors:string[]=[],formatRepairs=0;
  const failureHistory:string[]=[];
  let message='请理解节点图是生成前的需求与室内采光指标，直接返回完整策略 JSON，由服务器保存并交给几何求解器。';
  try {
    errors=checkResidentialBrief(input.residentialBrief.brief,input.base).filter(i=>i.level==='error').map(i=>i.message);
    if(errors.length) {state.status='failed';return {failed:true};}
    for(let attempt=1;attempt<=3;attempt++) {
      if(controller.signal.aborted) throw controller.signal.reason??new Error('生成已取消');
      state.attempt=attempt;phase('agent');
      emit({type:'progress',message:`第 ${attempt}/3 轮：Agent 制定策略（单轮最多4分钟，无活动90秒停止）…`});
      const timing={attempt,agentMs:0,solverMs:0,validationMs:0,tools:0};state.timings.push(timing);
      let output='',agentError=false,formatError=false;const agentStart=Date.now();
      try {
        const remaining=taskDeadline-Date.now();if(remaining<=0)throw new GenerationTimeout('住宅生成达到12分钟总预算，已停止');
        const result=await boundedAgent(adapter,{cwd:agentCwd,message,systemPrompt:prompt,nativeSessionId,model:input.model,strategyOnly:true},event=> {
          if(event.type==='text') {output+=event.text;return;}
          if(event.type==='error') agentError=true;
          if(event.type==='progress'&&event.message.startsWith('调用工具'))timing.tools++;
          emit(event);
        },controller.signal,{totalMs:Math.min(240000,remaining),idleMs:Math.min(90000,remaining)});
        timing.agentMs=Date.now()-agentStart;
        nativeSessionId=result.nativeSessionId??nativeSessionId;
        fs.writeFileSync(path.join(folder,`agent-response-${attempt}${formatRepairs?`-repair-${formatRepairs}`:''}.txt`),output);
        if(result.failed||agentError) {errors=['Agent 未完成策略生成'];state.status='failed';break;}
        phase('strategy_validation');
        const text=output.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
        let strategy:ReturnType<typeof parseResidentialStrategy>;
        try {strategy=parseResidentialStrategy(JSON.parse(text),input.residentialBrief.brief,input.base);if(strategy.schemaVersion!==2)throw new Error('新住宅生成只接收schemaVersion 2布局意图；旧切分策略仅用于历史回放');}catch(e){formatError=true;throw e;}
        write(`strategy-attempt-${attempt}.json`,strategy);write('strategy.json',strategy);
        emit({type:'text',text:`第 ${attempt} 轮布局策略：${strategy.rationale}\n`});
        emit({type:'progress',message:'几何求解器正在预留公共空间主体，联合检查墙体关系、房间、门位与通路…'});phase('solver');
        const solverStart=Date.now();let solved:ReturnType<typeof solveResidentialLayout>;
        const useDaylight=!!input.sessionId&&input.residentialBrief.brief.rooms.some(r=>roomDaylight(r).enabled);
        try {solved=solve(input.base,input.residentialBrief.brief,strategy,input.revisionId,{candidateLimit:useDaylight?3:1});}finally{timing.solverMs=Date.now()-solverStart;}
        let {model,report}=solved;phase('validation');const validationStart=Date.now();
        errors=[...validateAgentModel(model).errors,...validateModel(model).errors,...validateResidentialCandidate(model,input.base,input.residentialBrief)];
        timing.validationMs=Date.now()-validationStart;
        if(errors.length) throw new Error(errors.join('；'));
        const attachBrief=(candidate:SpaceModel,qualityChecksVersion:number)=>{
          candidate.model.residentialBrief={baseRevisionId:input.residentialBrief.brief.baseRevisionId,version:input.residentialBrief.version,status:'pending_simulation',geometryStatus:'checked',qualityStatus:'checked',solver:'grid',qualityChecksVersion};
        };
        let daylightRecord:ResidentialDaylightRecord|undefined;
        if(useDaylight&&'alternatives' in solved&&Array.isArray(solved.alternatives)&&solved.alternatives.length) {
          const alternatives=solved.alternatives as {model:SpaceModel;report:typeof report}[];
          phase('daylight_selection');
          const config=briefDaylightConfig(input.residentialBrief.brief);
          const summaries:{index:number;status:string;rank?:number[];error?:string;taskId?:string}[]=[];
          let selected:{model:SpaceModel;report:typeof report;record:ResidentialDaylightRecord;rank:number[]}|undefined;
          for(const [index,candidate] of alternatives.entries()) {
            if(controller.signal.aborted)throw controller.signal.reason??new Error('生成已取消');
            if(taskDeadline-Date.now()<15000)break;
            attachBrief(candidate.model,candidate.report.qualityChecksVersion);
            emit({type:'progress',message:`正在对几何候选 ${index+1}/${alternatives.length} 运行 Radiance 采光评价…`});
            try {
              const out=await runResidentialDaylightPlan({sessionId:input.sessionId!,revisionId:input.revisionId,model:candidate.model,config,signal:controller.signal});
              const evaluation=evaluateResidentialDaylight(candidate.model,input.residentialBrief.brief,input.residentialBrief.version,out.result);
              const rank=daylightRank(evaluation);
              const identity=residentialEvaluationIdentity(input.sessionId!,input.revisionId,candidate.model,input.residentialBrief,'daylight',config,DAYLIGHT_ENGINE_ID);
              const inputHash=identity.inputHash;
              const now=new Date().toISOString();
              const record:ResidentialDaylightRecord={identity,kind:'indoor-daylight',status:'completed',revisionId:input.revisionId,briefVersion:input.residentialBrief.version,startedAt:now,finishedAt:now,inputHash,engineVersion:DAYLIGHT_ENGINE_ID,taskId:out.taskId,result:out.result,evaluation};
              summaries.push({index,status:evaluation.status,rank,taskId:out.taskId});
              if(!selected||compareRank(rank,selected.rank)<0)selected={model:candidate.model,report:candidate.report,record,rank};
            }catch(error) {
              if(controller.signal.aborted)throw error;
              summaries.push({index,status:'failed',error:error instanceof Error?error.message:String(error),
                ...(error instanceof EngineTaskExecutionError ? {taskId:error.taskId} : {})});
            }
          }
          if(!selected)throw new ResidentialSolveError('几何候选已找到，但采光模拟均未完成；请检查采光引擎或重新生成',{status:'daylight_simulation_failed',candidates:summaries});
          model=selected.model;report=selected.report;daylightRecord=selected.record;
          (report as typeof report & {daylightSelection?:unknown}).daylightSelection={method:'radiance-candidate-ranking',candidateCount:summaries.length,selectedIndex:summaries.find(s=>s.taskId===selected.record.taskId)?.index??0,candidates:summaries};
          errors=[...validateAgentModel(model).errors,...validateModel(model).errors,...validateResidentialCandidate(model,input.base,input.residentialBrief)];
          if(errors.length)throw new Error(errors.join('；'));
        } else attachBrief(model,report.qualityChecksVersion);
        const warnings=[...report.warnings,...report.quality.warnings,daylightRecord?'已按实际 Radiance 采光结果选择几何候选':'几何、通行净宽及门位检查已完成；室内采光待Radiance评价'];
        write('solver-report.json',report);
        fs.writeFileSync(path.join(folder,'model.json.tmp'),JSON.stringify(model,null,2));fs.renameSync(path.join(folder,'model.json.tmp'),path.join(folder,'model.json'));
        if(daylightRecord)write('residential-daylight-evaluation.json',daylightRecord);
        write('validation.json',{valid:true,status:'accepted',attempts:attempt,warnings,assumptions:[strategy.rationale]});
        state.status='completed';phase('completed');
        emit({type:'design',revisionId:input.revisionId,valid:true,errors:[],warnings});return {failed:false};
      } catch(error) {
        timing.agentMs ||= Date.now()-agentStart;
        errors=[error instanceof Error?error.message:String(error)];
        if(error instanceof GenerationTimeout) {state.status='timed_out';break;}
        if(controller.signal.aborted) throw error;
        const report={...(error instanceof ResidentialSolveError ? error.report : {}),status:'rejected',failureType:formatError?'strategy_format':error instanceof ResidentialSolveError?(error.report.status??'geometry_search'):'model_validation',attempt,errors,timings:timing};write(`solver-attempt-${attempt}${formatError?`-format-${formatRepairs+1}`:''}.json`,report);write('solver-report.json',report);
        if(formatError&&formatRepairs>=2){state.status='failed';emit({type:'progress',message:'策略格式修复次数已用完，停止生成'});break;}
        if(error instanceof ResidentialSolveError&&['unsupported_geometry','unsupported_program','grid_budget','infeasible_input','no_room_candidate','daylight_simulation_failed'].includes(String(error.report.status))) {
          state.status='failed';emit({type:'progress',message:errors[0]});break;
        }
        const conflicts=error instanceof ResidentialSolveError?JSON.stringify({failureType:error.report.status,failures:error.report.failures,earlyConnectionPrunes:error.report.earlyConnectionPrunes}):'';
        const named=(errors.join('；')+(conflicts?'\n具体搜索冲突：'+conflicts:'')).replace(/room-[A-Za-z0-9_-]+|rel-[A-Za-z0-9_-]+/g,id=> {
          const brief=input.residentialBrief.brief;const r=brief.rooms.find(r=>r.id===id);if(r)return `${r.name}（${id}）`;
          const edge=brief.relations.find(r=>r.id===id);return edge ? `${brief.rooms.find(r=>r.id===edge.from)?.name??edge.from}→${brief.rooms.find(r=>r.id===edge.to)?.name??edge.to}（${id}）`:id;
        });
        if(formatError&&formatRepairs<2) {
          formatRepairs++;attempt--;
          message=`策略格式修复（不消耗布局求解轮次）：${named}。请重新返回完整、可解析的策略JSON。\n已知布局冲突：\n${failureHistory.join('\n')}\n不要修改需求或固定构件。`;
          emit({type:'progress',message:`策略格式无效，进行第${formatRepairs}/2次独立修复…`});
        } else {
          if(!formatError)failureHistory.push(`布局第${attempt}轮：${named}`);
          message=`上轮策略失败：${named}\n累计布局冲突：\n${failureHistory.join('\n')}\n请调整功能分区、窗偏好或安排次序，求解器会联合搜索房间与通路。这不证明需求无解。直接返回新的完整JSON，不要修改需求、工况或工程实现。`;
        }
        emit({type:'progress',message:errors[0]});
        if(!formatError&&attempt===3){state.status='failed';emit({type:'progress',message:'三个布局轮次已用完，保留失败报告；搜索失败不代表需求无解'});break;}
        phase('retry');
      }
    }
    if(state.status==='running')state.status='failed';return {failed:true};
  } catch(error) {
    errors=[error instanceof Error?error.message:'生成已取消'];
    state.status=state.status==='interrupted'?'interrupted':'cancelled';return {failed:true};
  } finally {
    signal?.removeEventListener('abort',cancel);unregister();
    if(state.status!=='completed') {
      state.errors=errors;state.phase=state.status;
      write('validation.json',{valid:false,status:state.status,errors});
      emit({type:'design',revisionId:input.revisionId,valid:false,errors});
    }
    persistGeneration(folder,state);
  }
}
