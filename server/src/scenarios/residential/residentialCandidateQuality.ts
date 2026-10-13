import { layoutSettings, permitsThrough, type ResidentialBrief, type SpaceModel, type Vec2 } from '@sdd/shared';
import { openingFacesOutside, openingRoomSides } from '../../geometry/openingSides';
import { doorApron, doorSwingFits, swingFootprint, swingCollision } from '../../geometry/doorGeometry';
import { openSpaceConnections } from '../../geometry/openSpaceConnections';
import { assessRoomQuality, structuralGapErrors, type RoomQuality } from './residentialQuality';
import { CIRCULATION } from './residentialStrategy';
import { assessStructuralWallRelationships } from './structuralWallRelationships';
import { assessPublicSpaceQuality } from './publicSpaceQuality';
import { assessWallAlignment } from './wallAlignment';
import { assessStructuralConnections } from '../../design/structuralWallConnections';

/** Auditable usability gate; applies to generated candidates as well as historical layouts. */
export function assessResidentialQuality(model:SpaceModel,brief:ResidentialBrief,precomputed:Record<string,RoomQuality>={},intentMode=false) {
  const scale=model.model.units==='mm'?1000:1,errors:string[]=[],warnings:string[]=[];
  const settings=layoutSettings(brief);
  const rooms=model.spaces.map(s=>{const req=brief.rooms.find(r=>r.id===s.id);return {id:s.id,name:s.usage,...(precomputed[s.id]??assessRoomQuality(s.boundary,req?.kind??'circulation',scale,intentMode?{routeWidth:settings.passageWidth,body:req?.bodySize}:undefined))};});
  for(const room of rooms) {
    const req=brief.rooms.find(r=>r.id===room.id);
    for(const e of room.errors) {
      const hard=!intentMode||e.includes('超出质量检查')||(req?.bodySize&&e.includes('无法容纳'))||((!req||permitsThrough(req))&&(e.includes('窄颈')||e.includes('缺少满足')));
      (hard?errors:warnings).push(`${room.name}: ${intentMode&&!hard?e.replace('，不能作为有效房间面积','，建议优化利用'):e}`);
    }
  }
  const structural=model.walls.filter(w=>w.fixed&&w.role==='structural'&&!openingFacesOutside(w,w.geometry.points[0],w.geometry.points.at(-1)!,model.floor.boundary));
  (intentMode?warnings:errors).push(...structuralGapErrors(model.walls.filter(w=>w.generatedBy),structural,scale));
  const structuralWalls=assessStructuralWallRelationships(model,brief),publicSpaces=assessPublicSpaceQuality(model,brief);
  const wallAlignment=assessWallAlignment(model,brief);
  const structuralConnections=assessStructuralConnections(model);
  warnings.push(...structuralWalls.warnings);
  warnings.push(...wallAlignment.warnings);
  warnings.push(...structuralConnections.warnings);
  for(const space of publicSpaces)if(space.coreRatio<.5)warnings.push(`${space.name}最大完整矩形仅占${(space.coreRatio*100).toFixed(0)}%，其余${space.fragmentationArea.toFixed(2)}㎡需结合交通及家具布置复核`);
  const swingAreas:{id:string;boundary:Vec2[]}[]=[],neighbours=new Map<string,Set<string>>([...model.spaces.map(s=>s.id),'outside'].map(id=>[id,new Set<string>()]));
  const openConnections=openSpaceConnections(model).filter(c=>c.netWidthM+1e-7>=settings.passageWidth);
  for(const {from,to} of openConnections){neighbours.get(from)?.add(to);neighbours.get(to)?.add(from);}
  for(const door of model.doors) {
    const o=model.openings.find(o=>o.id===door.openingId)!,wall=model.walls.find(w=>w.id===o.hostWallId)!;
    if(o.generatedBy&&(door.swing==='none'||!door.opensTo))errors.push(`新增门 ${door.id} 未定义门扇开启方向`);
    const sides=openingRoomSides(model,wall,o.position,o.width),apr=doorApron(model,wall,o.position,o.width,settings.doorDepth);
    if(!sides.filter(s=>s!=='outside').every(id=>apr.some(a=>a.roomId===id)))errors.push(`门 ${door.id} 缺少${settings.doorDepth.toFixed(2)}m门前净空或无法进入房间主体`);
    if(sides.length===2)for(const id of sides)neighbours.get(id)?.add(sides.find(s=>s!==id)!);
    if(door.swing!=='none'&&door.opensTo){const boundary=swingFootprint(model,wall,o.position,o.width,door.opensTo,door.hinge??'start');const target=apr.find(a=>a.side===door.opensTo);if(!target||!doorSwingFits(model,wall,boundary,target.roomId))errors.push(`门 ${door.id} 门扇碰撞墙体或越出目标房间`);for(const old of swingAreas)if(swingCollision(boundary,old.boundary,scale))errors.push(`门扇开启冲突：${door.id} 与 ${old.id}`);swingAreas.push({id:door.id,boundary});}
  }
  let penalty=rooms.reduce((n,r)=>n+r.penalty,0)+structuralWalls.penalty+wallAlignment.penalty+publicSpaces.reduce((n,s)=>n+s.penalty,0);
  const circulation=rooms.find(r=>r.id===CIRCULATION);
  let circulationReview: {area:number;servedRoomIds:string[];redundant:boolean;openConnections:{spaceId:string;netWidthM:number}[]}|undefined;
  if(circulation){
    const space=model.spaces.find(s=>s.id===CIRCULATION)!;
    const publicOpen=openConnections.filter(c=>[c.from,c.to].includes(CIRCULATION)&&brief.rooms.some(r=>r.id===(c.from===CIRCULATION?c.to:c.from)&&permitsThrough(r)));
    if(intentMode&&space.enclosed!==false)errors.push('自动交通空间不得作为封闭房间');
    if(intentMode&&!publicOpen.length)errors.push(`自动交通空间缺少与公共空间连接的${settings.passageWidth.toFixed(2)}m开放通道`);
    const connected=[...(neighbours.get(CIRCULATION)??[])];
    const privateIds=connected.filter(id=>brief.rooms.some(r=>r.id===id&&!permitsThrough(r)));
    const reachableWithout=(target:string)=>{const reached=new Set(['outside']),queue=['outside'];for(let i=0;i<queue.length;i++)for(const next of neighbours.get(queue[i])??[]){if(next===CIRCULATION||reached.has(next))continue;const requirement=brief.rooms.find(r=>r.id===next);if(next!==target&&next!=='outside'&&(!requirement||!permitsThrough(requirement)))continue;reached.add(next);queue.push(next);}return reached.has(target);};
    const redundant=!connected.includes('outside')&&privateIds.every(reachableWithout);
    circulationReview={area:circulation.area,servedRoomIds:privateIds,redundant,openConnections:publicOpen.map(c=>({spaceId:c.from===CIRCULATION?c.to:c.from,netWidthM:c.netWidthM}))};
    if(redundant){penalty+=1+circulation.area*.1;warnings.push('公共交通区移除后仍可到达其服务房间，存在重复交通面积');}
    penalty+=circulation.area/Math.max(1,rooms.reduce((n,r)=>n+r.area,0))*.5;
  }
  penalty+=model.walls.filter(w=>w.generatedBy).reduce((n,w)=>n+Math.hypot(w.geometry.points[1][0]-w.geometry.points[0][0],w.geometry.points[1][1]-w.geometry.points[0][1])/scale,0)*.01;
  return {errors:[...new Set(errors)],warnings,rooms,structuralWalls,publicSpaces,wallAlignment,structuralConnections,circulation:circulationReview,penalty,thresholds:{routeWidth:settings.passageWidth,doorDepth:settings.doorDepth,doorWidth:settings.doorWidth,partitionThickness:settings.partitionThickness,gridStep:.12},method:'wall-relationships-alignment-public-core-and-door-aprons'};
}
