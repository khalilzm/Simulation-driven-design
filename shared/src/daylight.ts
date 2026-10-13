import type { ResultIdentity } from './resultIdentity';
import type { ResidentialBrief,RoomRequirement } from './residentialBrief';
export interface RoomDaylightTarget {enabled:boolean;minIlluminanceLux:number;minAreaRatio:number;priority:'hard'|'soft'}
export interface DaylightSettings {
  method:'overcast-daylight-factor';outdoorIlluminanceLux:number;
  sensors:{referenceHeightAboveFloor:number;gridSpacing:number};
  materials:{wallReflectance:number;ceilingReflectance:number;floorReflectance:number;windowTransmittance:number};
}
export interface DaylightConfig extends DaylightSettings {schemaVersion:'1';targets:{roomId:string;minIlluminanceLux:number;minAreaRatio:number;priority:'hard'|'soft'}[]}
export const DEFAULT_DAYLIGHT_SETTINGS:DaylightSettings={method:'overcast-daylight-factor',outdoorIlluminanceLux:10000,sensors:{referenceHeightAboveFloor:.75,gridSpacing:.5},materials:{wallReflectance:.5,ceilingReflectance:.8,floorReflectance:.2,windowTransmittance:.65}};
export const roomDaylight=(room:RoomRequirement):RoomDaylightTarget=>room.daylight??{enabled:room.sunlight.enabled,minIlluminanceLux:300,minAreaRatio:room.sunlight.minAreaRatio,priority:room.sunlight.priority};
export const daylightSettings=(brief:ResidentialBrief):DaylightSettings=>brief.daylight??{...structuredClone(DEFAULT_DAYLIGHT_SETTINGS),sensors:{...brief.sunlight.sensors}};
export function briefDaylightConfig(brief:ResidentialBrief):DaylightConfig {return {schemaVersion:'1',...structuredClone(daylightSettings(brief)),targets:brief.rooms.filter(r=>roomDaylight(r).enabled).map(r=>({roomId:r.id,...roomDaylight(r)}))};}
export function daylightSettingsError(settings:DaylightSettings):string|undefined {
  if(!settings||settings.method!=='overcast-daylight-factor'||!Number.isFinite(settings.outdoorIlluminanceLux)||settings.outdoorIlluminanceLux<1000||settings.outdoorIlluminanceLux>100000)return '室外参考照度须为1000～100000 lx';
  if(!settings.sensors||!Number.isFinite(settings.sensors.gridSpacing)||settings.sensors.gridSpacing<.1||settings.sensors.gridSpacing>2||!Number.isFinite(settings.sensors.referenceHeightAboveFloor)||settings.sensors.referenceHeightAboveFloor<0||settings.sensors.referenceHeightAboveFloor>3)return '采光测点间距或高度无效';
  if(!settings.materials||![settings.materials.wallReflectance,settings.materials.ceilingReflectance,settings.materials.floorReflectance].every(v=>Number.isFinite(v)&&v>=.01&&v<=.95)||!Number.isFinite(settings.materials.windowTransmittance)||settings.materials.windowTransmittance<.05||settings.materials.windowTransmittance>1)return '反射率或窗透光率无效';
}
export interface DaylightSpaceMetrics {spaceId:string;allocationId:string;sensorCount:number;sampledArea:number;meanLux:number;minLux:number;maxLux:number;meanDaylightFactor:number;targetMetRatio:number|null}
export interface DaylightSampling {status:'converged'|'needs_review';baseSpacing:number;refinedSpacing:number;rooms:{allocationId:string;status:'converged'|'needs_review';reason?:string|null;meanLuxDelta:number;targetRatioDelta:number|null;baseTargetRatio:number|null;refinedTargetRatio:number|null}[]}
export interface DaylightResult {schemaVersion:'1';status:'completed'|'failed';engineVersion:string;error?:string;method:'overcast-daylight-factor';outdoorIlluminanceLux:number;spaces:DaylightSpaceMetrics[];grids:{gridId:string;spaceId:string;vertices:[number,number,number][];faces:number[][];lux:number[];daylightFactors:number[]}[];sampling?:DaylightSampling;assumptions:string[]}
export interface ResidentialDaylightEvaluation {schemaVersion:1;kind:'indoor-daylight';revisionId:string;briefVersion:number;status:'passed'|'failed'|'needs_review'|'not_configured';hardUnmetCount:number;softUnmetCount:number;rooms:{roomId:string;name:string;enabled:boolean;priority:'hard'|'soft';status:'passed'|'failed'|'needs_review'|'not_configured';minIlluminanceLux:number;requiredRatio:number;actualRatio:number|null;meanLux:number|null;minLux:number|null;maxLux:number|null;meanDaylightFactor:number|null;evaluatedArea:number;coverageRatio:number;sensorCount:number;samplingStatus:'converged'|'needs_review';reason?:string}[];assumptions:string[]}
export interface ResidentialDaylightRecord {identity?:ResultIdentity;kind:'indoor-daylight';status:'running'|'completed'|'failed'|'cancelled'|'stale';revisionId:string;briefVersion:number;startedAt:string;finishedAt?:string;inputHash:string;engineVersion:string;taskId?:string;evaluation?:ResidentialDaylightEvaluation;result?:DaylightResult;error?:string}
