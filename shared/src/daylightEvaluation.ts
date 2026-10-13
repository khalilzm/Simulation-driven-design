import type {SpaceModel} from './model';
import type {ResidentialBrief} from './residentialBrief';
import {roomDaylight,daylightSettings,type DaylightResult,type ResidentialDaylightEvaluation} from './daylight';
const area=(ring:number[][])=>Math.abs(ring.slice(0,-1).reduce((n,p,i)=>n+p[0]*ring[i+1][1]-ring[i+1][0]*p[1],0))/2;
export function evaluateResidentialDaylight(model:SpaceModel,brief:ResidentialBrief,version:number,result:DaylightResult):ResidentialDaylightEvaluation {
 const rooms=brief.rooms.map(r=>{
  const target=roomDaylight(r),metric=result.spaces.find(s=>s.allocationId===r.id),geometry=model.spaces.filter(s=>(s.allocationId??s.id)===r.id),total=geometry.reduce((n,s)=>n+area(s.boundary)/(model.model.units==='mm'?1e6:1),0);
  const sampling=result.sampling?.rooms.find(s=>s.allocationId===r.id),coverage=total?(metric?.sampledArea??0)/total:0;
  const valid=result.status==='completed'&&result.method==='overcast-daylight-factor'&&!!metric&&[metric.meanLux,metric.minLux,metric.maxLux,metric.meanDaylightFactor,metric.targetMetRatio].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)&&metric.targetMetRatio!<=1&&metric.sensorCount>0&&coverage>=.98&&coverage<=1.02&&sampling?.status==='converged'&&metric.targetMetRatio!==null;
  const status=!target.enabled?'not_configured' as const:!valid?'needs_review' as const:metric.targetMetRatio!+1e-6>=target.minAreaRatio?'passed' as const:'failed' as const;
  return {roomId:r.id,name:r.name,enabled:target.enabled,priority:target.priority,status,minIlluminanceLux:target.minIlluminanceLux,requiredRatio:target.minAreaRatio,actualRatio:valid?metric!.targetMetRatio:null,meanLux:metric?.meanLux??null,minLux:metric?.minLux??null,maxLux:metric?.maxLux??null,meanDaylightFactor:metric?.meanDaylightFactor??null,evaluatedArea:metric?.sampledArea??0,coverageRatio:coverage,sensorCount:metric?.sensorCount??0,samplingStatus:sampling?.status??'needs_review' as const,...(status==='needs_review'?{reason:!metric?'缺少照度结果':sampling?.reason??'覆盖率或采样精度待确认'}:{})};
 });
 const active=rooms.filter(r=>r.enabled),hardUnmetCount=active.filter(r=>r.priority==='hard'&&r.status==='failed').length,softUnmetCount=active.filter(r=>r.priority==='soft'&&r.status==='failed').length;
 const status=!active.length?'not_configured':active.some(r=>r.status==='needs_review')?'needs_review':hardUnmetCount?'failed':'passed';
 return {schemaVersion:1,kind:'indoor-daylight',revisionId:model.model.revisionId,briefVersion:version,status,hardUnmetCount,softUnmetCount,rooms,assumptions:[...result.assumptions,...(model.externalContext.length?['包含已提供的外部遮挡']:['未提供周边建筑遮挡']),`评价高度${daylightSettings(brief).sensors.referenceHeightAboveFloor}m；标准阴天天空不随日期和朝向变化`]};
}
