import type { ResultIdentity } from './resultIdentity';
import type { ResidentialBrief, SpaceModel } from './index';
import type { SunlightResult } from './sunlight';
export interface ResidentialRoomEvaluation {
  roomId:string;name:string;enabled:boolean;priority:'hard'|'soft';
  status:'passed'|'failed'|'needs_review'|'not_configured';
  minHours:number;requiredRatio:number;actualRatio:number|null;ratioGap:number|null;
  evaluatedArea:number;roomArea:number;coverageRatio:number;sensorCount:number;
  samplingStatus:'converged'|'needs_review';samplingMeanDelta:number|null;samplingRatioDelta:number|null;
  meanHours:number|null;minActualHours:number|null;maxHours:number|null;reason?:string;
}
export interface ResidentialEvaluation {
  schemaVersion:1;revisionId:string;briefVersion:number;status:'passed'|'failed'|'needs_review'|'not_configured';
  /** Overall passed means no unmet hard targets; soft deficits remain explicit. */
  hardUnmetCount:number;softUnmetCount:number;rooms:ResidentialRoomEvaluation[];assumptions:string[];
}
export interface ResidentialEvaluationRecord {
  identity?:ResultIdentity;
  status:'running'|'completed'|'failed'|'cancelled'|'stale';revisionId:string;briefVersion:number;
  startedAt:string;finishedAt?:string;inputHash:string;engineVersion:string;taskId?:string;
  evaluation?:ResidentialEvaluation;result?:SunlightResult;error?:string;
}
const area=(ring:number[][])=>Math.abs(ring.slice(0,-1).reduce((n,p,i)=>n+p[0]*ring[i+1][1]-ring[i+1][0]*p[1],0))/2;
/** Residential targets mean area coverage at a duration, not every sensor passing. */
export function evaluateResidentialSunlight(model:SpaceModel,brief:ResidentialBrief,briefVersion:number,result:SunlightResult):ResidentialEvaluation {
  const scale=model.model.units==='mm'?1e6:1;
  const rooms=brief.rooms.map(req=>{
    const spaces=model.spaces.filter(s=>(s.allocationId??s.id)===req.id);
    const roomArea=spaces.reduce((n,s)=>n+area(s.boundary)/scale,0);
    const metrics=result.allocations?.find(a=>a.allocationId===req.id)??(spaces.length===1?result.spaces.find(s=>s.spaceId===spaces[0].id):undefined);
    const evaluatedArea=metrics?.sampledArea??0,coverageRatio=roomArea?evaluatedArea/roomArea:0;
    const actual=metrics?.targetMetRatio;
    const sampling=result.sampling?.rooms.find(r=>r.allocationId===req.id);
    const crosses=sampling?.baseTargetRatio!==null&&sampling?.baseTargetRatio!==undefined&&sampling?.refinedTargetRatio!==null&&sampling?.refinedTargetRatio!==undefined&&((sampling.baseTargetRatio+1e-9>=req.sunlight.minAreaRatio)!==(sampling.refinedTargetRatio+1e-9>=req.sunlight.minAreaRatio));
    const samplingValid=sampling?.status==='converged'&&!crosses;
    const valid=samplingValid&&result.status==='completed'&&spaces.length>0&&!!metrics&&Number.isFinite(metrics.sensorCount)&&metrics.sensorCount>0&&actual!==null&&actual!==undefined&&Number.isFinite(actual)&&actual>=0&&actual<=1&&coverageRatio>=.98&&coverageRatio<=1.02;
    const status:ResidentialRoomEvaluation['status']=!req.sunlight.enabled?'not_configured':!valid?'needs_review':actual!+1e-9>=req.sunlight.minAreaRatio?'passed':'failed';
    return {roomId:req.id,name:req.name,enabled:req.sunlight.enabled,priority:req.sunlight.priority,status,minHours:req.sunlight.minHours,requiredRatio:req.sunlight.minAreaRatio,actualRatio:valid?actual!:null,ratioGap:valid?Math.max(0,req.sunlight.minAreaRatio-actual!):null,evaluatedArea,roomArea,coverageRatio,sensorCount:metrics?.sensorCount??0,samplingStatus:samplingValid?'converged' as const:'needs_review' as const,samplingMeanDelta:sampling?.meanHoursDelta??null,samplingRatioDelta:sampling?.targetRatioDelta??null,meanHours:metrics?.meanHours??null,minActualHours:metrics?.minHours??null,maxHours:metrics?.maxHours??null,...(status==='needs_review'?{reason:result.status!=='completed'?'日照计算失败':!metrics?'缺少房间测点或结果':!samplingValid?crosses?'两级采样跨越目标阈值，需要进一步细化':sampling?.reason??'采样精度尚未确认':'评价网格覆盖不足或指标无效'}:{})};
  });
  const active=rooms.filter(r=>r.enabled),hardUnmetCount=active.filter(r=>r.priority==='hard'&&r.status==='failed').length,softUnmetCount=active.filter(r=>r.priority==='soft'&&r.status==='failed').length;
  const status:ResidentialEvaluation['status']=!active.length?'not_configured':active.some(r=>r.status==='needs_review')?'needs_review':hardUnmetCount?'failed':'passed';
  return {schemaVersion:1,revisionId:model.model.revisionId,briefVersion,status,hardUnmetCount,softUnmetCount,rooms,assumptions:['累计直射日照时长；不等同于采光照度','门按关闭、不透明处理；窗洞按透明开口处理',...(model.externalContext.length?['包含模型中提供的外部遮挡']:['未提供周边建筑遮挡，仅评价当前模型']),`测点高度${brief.sunlight.sensors.referenceHeightAboveFloor}m，基础间距${brief.sunlight.sensors.gridSpacing}m，时间步长${brief.sunlight.timestepMinutes}分钟`,...(result.sampling?[`窗投影区两级细化${result.sampling.baseFineStep??'—'}m／${result.sampling.refinedFineStep??'—'}m；覆盖率不代表采样收敛`]:['缺少采样收敛检查'])]};
}
