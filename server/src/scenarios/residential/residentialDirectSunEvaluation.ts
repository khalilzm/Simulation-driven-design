import { residentialEvaluationIdentity } from './evaluationIdentity';
import fs from 'node:fs';
import path from 'node:path';
import { briefSunlightConfig, evaluateResidentialSunlight, type SunlightResult, type ResidentialEvaluation, type ResidentialBriefDocument, type ResidentialEvaluationRecord } from '@sdd/shared';
import { workspacesDir, sunlightEngineId } from '../../config';
import { loadDesign, isAcceptedDesign } from '../../model/store';
import { runSunlightAnalysis } from '../../sunlight/run';
import { createEvaluationRuntime } from '../../analysis/runtime/evaluation';
function inputs(sessionId:string,revisionId:string) {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)||!/^rev-\d+$/.test(revisionId))throw new Error('住宅评价版本无效');
  const model=loadDesign(sessionId,revisionId);if(!model?.model.residentialBrief||!isAcceptedDesign(sessionId,revisionId,model))throw new Error('请选择通过几何检查的节点图生成候选');
  const folder=path.join(workspacesDir,sessionId,'designs',revisionId),file=path.join(folder,'residential-evaluation.json');
  const document=JSON.parse(fs.readFileSync(path.join(folder,'generation-brief.json'),'utf8')) as ResidentialBriefDocument;
  if(document.version!==model.model.residentialBrief.version||document.brief.baseRevisionId!==model.model.residentialBrief.baseRevisionId)throw new Error('候选与冻结需求版本不一致');
  const config=briefSunlightConfig(document.brief);
  const identity=residentialEvaluationIdentity(sessionId,revisionId,model,document,'sunlight',config,sunlightEngineId);
  return {model,document,config,identity,inputHash:identity.inputHash,file};
}
const runtime=createEvaluationRuntime<ReturnType<typeof inputs>,SunlightResult,ResidentialEvaluation,ResidentialEvaluationRecord>({
  inputs,
  createRecord:(input,revisionId)=>({identity:input.identity,status:'running',revisionId,briefVersion:input.document.version,startedAt:new Date().toISOString(),inputHash:input.inputHash,engineVersion:sunlightEngineId}),
  assess:(input,result)=>evaluateResidentialSunlight(input.model,input.document.brief,input.document.version,result),
  validateResult(result){if(result.status!=='completed')throw new Error(result.error??'日照引擎未完成计算');if(result.engineVersion!==sunlightEngineId)throw new Error('日照结果报告的引擎版本与执行配置不一致');},
  messages:{stale:'模型、工况或引擎已变化，需要重新评价',interrupted:'上次日照评价已中断，请重新运行',concurrent:'该候选正在进行日照评价'},
});
export const loadResidentialEvaluation=runtime.load;
export async function runResidentialEvaluation(sessionId:string,revisionId:string,signal?:AbortSignal,analyze:typeof runSunlightAnalysis=runSunlightAnalysis):Promise<ResidentialEvaluationRecord> {
  return runtime.run(sessionId,revisionId,signal,(input,signal)=>analyze({sessionId,revisionId,model:input.model,configRaw:input.config,signal}));
}
