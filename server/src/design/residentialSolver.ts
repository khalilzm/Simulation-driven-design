import { diff, intersection, type Geometry } from 'martinez-polygon-clipping';
import { pointInOrOnPolygon, polygonGeometryError, type ResidentialBrief, type SpaceModel, type Vec2, type Wall, layoutSettings, permitsThrough } from '@sdd/shared';
import { boundsOf, pointAlongWallPolyline, polygonArea } from '../model/geometry';
import { cleanRing, geometryArea, polygons, rectangle } from './regionGeometry';
import { openingFacesOutside } from './layoutAccess';
import { assessRoomQuality, doorApron, doorSwingFits, swingFootprint, swingCollision, structuralGapErrors, type RoomQuality } from './residentialQuality';
import { CIRCULATION, type PartitionStrategy, type ResidentialStrategy, type LegacyResidentialStrategy } from './residentialStrategy';

/** Room boundaries describe usable wall-face polygons. Legacy models use centerline polygons. */
export function openingRoomSides(model: SpaceModel, wall: Wall, position: number, width: number): string[] {
  const center = pointAlongWallPolyline(wall.geometry.points, position);
  const a = pointAlongWallPolyline(wall.geometry.points, position-width/2);
  const b = pointAlongWallPolyline(wall.geometry.points, position+width/2);
  if (!center || !a || !b) return [];
  const length = Math.hypot(b[0]-a[0],b[1]-a[1]);
  if (!length) return [];
  const offset = wall.thickness/2 + (model.model.units === 'mm' ? 0.01 : 0.00001);
  const normal: Vec2 = [-(b[1]-a[1])/length*offset,(b[0]-a[0])/length*offset];
  const found = new Set<string>();
  for (const sign of [-1,1]) {
    const probes = [0.001,0.5,0.999].map(t => [a[0]+t*(b[0]-a[0])+sign*normal[0],a[1]+t*(b[1]-a[1])+sign*normal[1]] as Vec2);
    const rooms = model.spaces.filter(s => probes.every(p => pointInOrOnPolygon(p,s.boundary,1e-8)));
    if (rooms.length === 1) found.add(rooms[0].id);
  }
  if (openingFacesOutside(wall,a,b,model.floor.boundary)) found.add('outside');
  return [...found];
}
export function footprint(wall: Wall, a: Vec2, b: Vec2): Vec2[] {
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
  const nx=-(b[1]-a[1])/length*wall.thickness/2,ny=(b[0]-a[0])/length*wall.thickness/2;
  return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny],[a[0]+nx,a[1]+ny]];
}
export class ResidentialSolveError extends Error {
  constructor(message:string, public readonly report:Record<string,unknown>) { super(message); this.name='ResidentialSolveError'; }
}
interface Solution { rooms: {id:string;boundary:Vec2[]}[]; walls: Wall[]; score:number }
const idsOf = (t:PartitionStrategy):string[] => 'roomId' in t ? [t.roomId] : [...idsOf(t.first),...idsOf(t.second)];

import { solveResidentialGrid } from './residentialGrid';

export function solveResidentialLayout(base:SpaceModel,brief:ResidentialBrief,strategy:ResidentialStrategy,revisionId:string) {
  return strategy.schemaVersion===2 ? solveResidentialGrid(base,brief,strategy,revisionId) : solveLegacyResidentialLayout(base,brief,strategy,revisionId);
}

/** Bounded beam search over metric cut positions; strategy controls topology, never room vertices. */
function solveLegacyResidentialLayout(base: SpaceModel, brief: ResidentialBrief, strategy: LegacyResidentialStrategy, revisionId: string) {
  const scale=base.model.units==='mm'?1000:1;
  const thickness=.12*scale;
  let usable:Geometry=[base.floor.boundary];
  for (const wall of base.walls) for(let i=0;i+1<wall.geometry.points.length;i++) {
    const a=wall.geometry.points[i],b=wall.geometry.points[i+1];
    if(Math.hypot(b[0]-a[0],b[1]-a[1])>1e-9) usable=diff(usable,[footprint(wall,a,b)])??[];
  }
  const available=geometryArea(usable)/scale**2;
  const targetSum=brief.rooms.reduce((n,r)=>n+r.area.target,0);
  const corridorTarget=Math.max(2,available-targetSum);
  const roomById=new Map(brief.rooms.map(r=>[r.id,r]));
  const target=(id:string)=>roomById.get(id)?.area.target??corridorTarget;
  const min=(id:string)=>roomById.get(id)?.area.min??1;
  const max=(id:string)=>roomById.get(id)?.area.max??available;
  const structural=base.walls.filter(w=>w.fixed&&w.role==='structural'&&!openingFacesOutside(w,w.geometry.points[0],w.geometry.points.at(-1)!,base.floor.boundary));
  const qualityCache=new Map<string,RoomQuality>();
  const quality=(id:string,boundary:Vec2[])=> {
    const kind=roomById.get(id)?.kind??'circulation';const key=kind+JSON.stringify(boundary);
    let result=qualityCache.get(key);if(!result){result=assessRoomQuality(boundary,kind,scale);qualityCache.set(key,result);}return result;
  };
  let visits=0, combinationChecks=0;
  const failures=new Map<string,number>();
  const rejectedCandidates:unknown[]=[];
  const rejectedRegions:Record<string,unknown>[]=[];
  const label=(id:string)=>roomById.get(id)?.name ?? (id===CIRCULATION?'公共交通区':id);
  const fail=(reason:string, detail?:Record<string,unknown>)=> {
    failures.set(reason,(failures.get(reason)??0)+1);
    if(detail && rejectedRegions.length<16 && rejectedRegions.filter(r=>r.phase===detail.phase).length<4) rejectedRegions.push({reason,...detail});
  };
  const contains=(geometry:Geometry,points:Vec2[])=>points.every(point=>polygons(geometry).some(rings=>
    pointInOrOnPolygon(point,rings[0],1e-8)&&!rings.slice(1).some(h=>pointInOrOnPolygon(point,h,1e-8))));
  const assets=base.openings.flatMap(opening=> {
    const wall=base.walls.find(w=>w.id===opening.hostWallId)!;
    const a=pointAlongWallPolyline(wall.geometry.points,opening.position-opening.width/2)!;
    const b=pointAlongWallPolyline(wall.geometry.points,opening.position+opening.width/2)!;
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    const offset=wall.thickness/2+1e-5*scale;
    const door=base.doors.find(d=>d.openingId===opening.id);
    const window=base.windows.find(w=>w.openingId===opening.id);
    const owner=door&&brief.relations.find(r=>r.kind==='direct'&&r.priority==='hard'&&[r.from,r.to].includes(`entrance:${door.id}`));
    return [-1,1].flatMap(sign=> {
      const points=[0.001,.5,.999].map(t=>[a[0]+t*(b[0]-a[0])-sign*(b[1]-a[1])/length*offset,a[1]+t*(b[1]-a[1])+sign*(b[0]-a[0])/length*offset] as Vec2);
      if(!contains(usable,points))return [];
      return [{id:opening.id,window:!!window,points,ownerId:owner?(owner.from.startsWith('entrance:')?owner.to:owner.from):undefined}];
    });
  });
  const makeModel=(candidate:Solution)=> {
    const model=structuredClone(base);model.model.revisionId=revisionId;model.model.parentRevisionId=base.model.revisionId;
    model.spaceTypes=[];model.spaces=candidate.rooms.map((r,i)=> {
      const name=roomById.get(r.id)?.name??'公共交通';
      model.spaceTypes!.push({id:`solver-type-${i}`,label:name,color:['#A8C8F0','#98D4B8','#FFE4A8','#C8B8E8','#FFB878','#88C8E8'][i%6]});
      return {id:r.id,allocationId:r.id,boundary:r.boundary,typeId:`solver-type-${i}`,usage:name,enclosed:true,targetArea:target(r.id),performancePreferences:{}};
    });
    model.walls.push(...candidate.walls);return model;
  };
  const hardPairs=brief.relations.filter(r=>r.priority==='hard'&&['direct','adjacent'].includes(r.kind)&&!r.from.startsWith('entrance:')&&!r.to.startsWith('entrance:'));
  const localConnections=(candidate:Solution):boolean=> {
    const ids=new Set(candidate.rooms.map(r=>r.id));
    const pairs=hardPairs.filter(r=>ids.has(r.from)&&ids.has(r.to));
    if(!pairs.length)return true;
    const model=makeModel(candidate);
    for(const relation of pairs) {
      let found=false;
      for(const wall of model.walls) {
        if(relation.kind==='direct'&&wall.fixed)continue;
        const length=Math.hypot(wall.geometry.points[1][0]-wall.geometry.points[0][0],wall.geometry.points[1][1]-wall.geometry.points[0][1]);
        const width=(relation.kind==='direct'?.9:.05)*scale;
        for(let p=width/2+.01*scale;p<=length-width/2;p+=.2*scale) {
          const sides=openingRoomSides(model,wall,p,width);
          if(sides.includes(relation.from)&&sides.includes(relation.to)){found=true;break;}
        }
        if(found)break;
      }
      if(!found){fail(`${label(relation.from)} 与 ${label(relation.to)} 无法兑现硬${relation.kind==='direct'?'直接连通':'相邻'}关系`);return false;}
    }
    return true;
  };
  function search(tree:PartitionStrategy, geometry:Geometry, path:string):Solution[] {
    if(++visits>16000) return [];
    const subtreeIds=idsOf(tree);
    const held=assets.filter(asset=>contains(geometry,asset.points));
    const needed=subtreeIds.filter(id=>roomById.get(id)?.window==='required').length;
    if(held.filter(a=>a.window).length<needed){fail(`${subtreeIds.map(label).join('、')}: 子分区完整窗数量不足`,{phase:'window_capacity',geometry:polygons(geometry),roomIds:subtreeIds});return [];}
    if(assets.some(asset=>asset.ownerId&&subtreeIds.includes(asset.ownerId)&&!held.includes(asset))){fail(`${subtreeIds.map(label).join('、')}: 分组失去必须直接关联的入户`);return [];}
    const bounds=boundsOf(polygons(geometry).flat(2));
    if(!bounds) return [];
    if('roomId' in tree) {
      const ps=polygons(geometry),area=geometryArea(geometry)/scale**2;
      if(ps.length!==1||ps[0].length!==1) {fail(`${label(tree.roomId)}: 分区不连通或包含墙体孔洞`,{phase:'leaf',roomId:tree.roomId,geometry:ps});return [];}
      if(area<min(tree.roomId)-1e-6||area>max(tree.roomId)+1e-6) {fail(`${label(tree.roomId)}: 无法满足净面积范围`,{phase:'leaf_area',roomId:tree.roomId,geometry:ps,area,range:[min(tree.roomId),max(tree.roomId)]});return [];}
      const boundary=cleanRing(ps[0][0]);
      if(polygonGeometryError(boundary)) return [];
      if(Math.min(bounds.maxX-bounds.minX,bounds.maxY-bounds.minY)<(tree.roomId===CIRCULATION?1:1.5)*scale) {fail(`${label(tree.roomId)}: 空间过窄`,{phase:'leaf_width',roomId:tree.roomId,geometry:ps,bounds});return [];}
      const shape=quality(tree.roomId,boundary);
      if(shape.errors.length){shape.errors.forEach(reason=>fail(`${label(tree.roomId)}: ${reason}`,{phase:'quality',roomId:tree.roomId,geometry:ps,quality:shape}));return [];}
      if(shape.usableArea<min(tree.roomId)-1e-6){fail(`${label(tree.roomId)}: 有效主体面积不足`);return [];}
      let score=((shape.usableArea-target(tree.roomId))/Math.max(target(tree.roomId),1))**2+shape.penalty;
      const preference=strategy.preferences.find(p=>p.roomId===tree.roomId);
      if(preference?.side) {
        const world={north:[0,1],south:[0,-1],east:[1,0],west:[-1,0]}[preference.side];
        const angle=brief.sunlight.northDegrees*Math.PI/180;
        const direction=[world[0]*Math.cos(angle)-world[1]*Math.sin(angle),world[0]*Math.sin(angle)+world[1]*Math.cos(angle)];
        const f=boundsOf(base.floor.boundary)!;
        score-=.4*((bounds.minX+bounds.maxX-f.minX-f.maxX)/(f.maxX-f.minX)*direction[0]+(bounds.minY+bounds.maxY-f.minY-f.maxY)/(f.maxY-f.minY)*direction[1]);
      }
      const probeModel={...base,spaces:[{id:tree.roomId,boundary}]} as SpaceModel;
      const windows=base.windows.filter(w=> {
        const o=base.openings.find(o=>o.id===w.openingId)!;const host=base.walls.find(w=>w.id===o.hostWallId)!;
        return openingRoomSides(probeModel,host,o.position,o.width).includes(tree.roomId);
      });
      const room=roomById.get(tree.roomId);
      if(room?.window==='required'&&!windows.length) {fail(`${label(tree.roomId)}: 未完整接触固定窗`);return [];}
      if(preference?.windowId&&!windows.some(w=>w.id===preference.windowId)) score+=2;
      if(room?.sunlight.enabled||room?.window==='preferred') score+=windows.length?-.5:1;
      return [{rooms:[{id:tree.roomId,boundary}],walls:[],score}];
    }
    const firstIds=idsOf(tree.first),secondIds=idsOf(tree.second),axis=tree.axis;
    const lo=axis==='x'?bounds.minX:bounds.minY,hi=axis==='x'?bounds.maxX:bounds.maxY;
    const share=firstIds.reduce((n,id)=>n+target(id),0)/[...firstIds,...secondIds].reduce((n,id)=>n+target(id),0);
    const coordinates=new Set<number>([lo+(hi-lo)*share]);
    for(const wall of structural)if(wall.geometry.points.every(p=>Math.abs(p[axis==='x'?0:1]-wall.geometry.points[0][axis==='x'?0:1])<1e-6))coordinates.add(wall.geometry.points[0][axis==='x'?0:1]);
    if(tree.alignWallId){coordinates.clear();coordinates.add(base.walls.find(w=>w.id===tree.alignWallId)!.geometry.points[0][axis==='x'?0:1]);}
    for(const asset of held)for(const point of asset.points) {const coord=point[axis==='x'?0:1];coordinates.add(coord-thickness/2-.01*scale);coordinates.add(coord+thickness/2+.01*scale);}
    for(let i=1;i<20;i++) coordinates.add(lo+(hi-lo)*i/20);
    for(const p of polygons(geometry).flat(2)) if(p[axis==='x'?0:1]>lo+scale*.5&&p[axis==='x'?0:1]<hi-scale*.5) coordinates.add(p[axis==='x'?0:1]);
    const results:Solution[]=[];
    const anchor=tree.alignWallId?base.walls.find(w=>w.id===tree.alignWallId)!.geometry.points[0][axis==='x'?0:1]:undefined;
    for(const at of [...coordinates].filter(at=>anchor===undefined||Math.abs(at-anchor)<1e-6).sort((a,b)=>Math.abs(a-lo-(hi-lo)*share)-Math.abs(b-lo-(hi-lo)*share))) {
      if(at<=lo||at>=hi)continue;
      const mask=(lower:boolean)=>axis==='x'
        ? rectangle(lower?lo-scale:at+thickness/2,bounds.minY-scale,lower?at-thickness/2:hi+scale,bounds.maxY+scale)
        : rectangle(bounds.minX-scale,lower?lo-scale:at+thickness/2,bounds.maxX+scale,lower?at-thickness/2:hi+scale);
      const g1=intersection(geometry,[mask(true)])??[],g2=intersection(geometry,[mask(false)])??[];
      if(held.some(asset=>!contains(g1,asset.points)&&!contains(g2,asset.points))){fail('切分穿过固定入户或窗',{phase:'cut',axis,at,geometry:polygons(geometry)});continue;}
      const a1=geometryArea(g1)/scale**2,a2=geometryArea(g2)/scale**2;
      if(a1<firstIds.reduce((n,id)=>n+min(id),0)||a1>firstIds.reduce((n,id)=>n+max(id),0)||a2<secondIds.reduce((n,id)=>n+min(id),0)||a2>secondIds.reduce((n,id)=>n+max(id),0)) continue;
      // Intersect a thin strip to find independent wall segments, retaining fixed obstacles.
      const epsilon=1e-6*scale;
      const strip=axis==='x'?rectangle(at-epsilon,bounds.minY-scale,at+epsilon,bounds.maxY+scale):rectangle(bounds.minX-scale,at-epsilon,bounds.maxX+scale,at+epsilon);
      const walls=polygons(intersection(geometry,[strip])).map((p,i):Wall=> {
        const b=boundsOf(p[0])!;
        return {id:`solver-wall-${path}-${i}`,geometry:{type:'polyline',points:axis==='x'?[[at,b.minY],[at,b.maxY]]:[[b.minX,at],[b.maxX,at]]},thickness,height:base.floor.height,fixed:false,role:'partition',generatedBy:'layout-v2'};
      });
      const gaps=structuralGapErrors(walls,structural,scale);
      if(gaps.length){gaps.forEach(reason=>fail(reason,{phase:'structural_gap',axis,at,walls}));continue;}
      const left=search(tree.first,g1,`${path}a`),right=search(tree.second,g2,`${path}b`);
      for(const a of left) for(const b of right) {
        const candidate={rooms:[...a.rooms,...b.rooms],walls:[...walls,...a.walls,...b.walls],score:a.score+b.score};
        combinationChecks++;
        if(!localConnections(candidate))continue;
        if(path==='r') {
          const model=makeModel(candidate),check=connectAndCheck(model,brief);
          if(check.errors.length) {
            check.errors.forEach(reason=>fail(reason));
            if(rejectedCandidates.length<8)rejectedCandidates.push({score:candidate.score,spaces:model.spaces,walls:candidate.walls,errors:check.errors});
            continue;
          }
        }
        if(path==='r'){const model=makeModel(candidate);const usage=assessResidentialQuality(model,brief,Object.fromEntries(candidate.rooms.map(r=>[r.id,quality(r.id,r.boundary)])));if(usage.errors.length){usage.errors.forEach(reason=>fail(reason));if(rejectedCandidates.length<8)rejectedCandidates.push({spaces:model.spaces,walls:candidate.walls,errors:usage.errors,quality:usage});continue;}candidate.score+=usage.penalty;}
        results.push(candidate);
      }
      results.sort((a,b)=>a.score-b.score);results.splice(24);
      if(visits>16000) break;
    }
    return results;
  }
  const candidates=search(strategy.partition,usable,'r');
  for(const candidate of candidates) {
    const model=makeModel(candidate),check=connectAndCheck(model,brief);
    if(!check.errors.length)return {model,report:{status:'solved',method:'bounded-binary-partition',searchVisits:visits,searchLimitReached:visits>16000,combinationChecks,candidateCount:candidates.length,score:candidate.score,netAvailableArea:available,rooms:model.spaces.map(s=>({id:s.id,netArea:polygonArea(s.boundary)/scale**2})),checks:check.checks,warnings:check.warnings,quality:assessResidentialQuality(model,brief,Object.fromEntries(candidate.rooms.map(r=>[r.id,quality(r.id,r.boundary)]))),qualityChecksVersion:1,rejectedCandidates,rejectedRegions}};
  }
  const reasons=[...failures].sort((a,b)=>b[1]-a[1]).slice(0,8);
  throw new ResidentialSolveError(`当前策略未找到可行排布（并非证明需求无解）。${reasons.map(([s])=>s).join('；') || '面积分配或切分拓扑不适用'}。尝试更换分组/方向。搜索 ${visits} 次。`,{status:'rejected',searchVisits:visits,combinationChecks,searchLimitReached:visits>16000,failures:reasons.map(([reason,count])=>({reason,count})),rejectedCandidates,rejectedRegions});
}

export function connectAndCheck(model:SpaceModel,brief:ResidentialBrief) {
  const scale=model.model.units==='mm'?1000:1,settings=layoutSettings(brief),width=settings.doorWidth*scale;
  const errors:string[]=[],warnings:string[]=[],checks:string[]=[];
  const publicIds=new Set([CIRCULATION,...brief.rooms.filter(permitsThrough).map(r=>r.id)]);
  const pair=(a:string,b:string)=>[a,b].sort().join('|');
  const noDoor=new Set(brief.relations.filter(r=>r.kind==='no_direct'&&r.priority==='hard').map(r=>pair(r.from,r.to)));
  const direct=new Set(brief.relations.filter(r=>r.kind==='direct').map(r=>pair(r.from,r.to)));
  const adjacency=new Set<string>(),fixedEdges:[string,string][]=[],entry=new Map<string,string>();
  const fixedSwings=model.doors.filter(d=>d.swing!=='none'&&d.opensTo).map(d=>{const o=model.openings.find(o=>o.id===d.openingId)!,w=model.walls.find(w=>w.id===o.hostWallId)!;return swingFootprint(model,w,o.position,o.width,d.opensTo!,d.hinge??'start');});
  interface Option {a:string;b:string;wall:Wall;p:number;side:'left'|'right';hinge:'start'|'end';footprint:Vec2[]}
  const options=new Map<string,Option[]>();
  for(const wall of model.walls) {
    const length=Math.hypot(wall.geometry.points[1][0]-wall.geometry.points[0][0],wall.geometry.points[1][1]-wall.geometry.points[0][1]);
    // Include boundary transitions and midpoints, not only an arbitrary 20cm sampling phase.
    const positions=new Set<number>();for(let p=width/2+.001*scale;p<=length-width/2;p+=.1*scale)positions.add(p);
    positions.add(length/2);
    const a=wall.geometry.points[0],z=wall.geometry.points[1],dx=(z[0]-a[0])/length,dy=(z[1]-a[1])/length;
    for(const space of model.spaces)for(const point of space.boundary){const t=(point[0]-a[0])*dx+(point[1]-a[1])*dy;positions.add(t+width/2+.001*scale);positions.add(t-width/2-.001*scale);}
    for(let p=.025*scale;p<length;p+=.1*scale){const sides=openingRoomSides(model,wall,p,.05*scale);if(sides.length===2&&!sides.includes('outside'))adjacency.add(pair(sides[0],sides[1]));}
    if(wall.fixed)continue;
    for(const p of [...positions].filter(p=>p>=width/2&&p<=length-width/2).sort((a,b)=>Math.abs(a-length/2)-Math.abs(b-length/2))) {
      const sides=openingRoomSides(model,wall,p,width);if(sides.length!==2||sides.includes('outside'))continue;
      const [a,b]=sides,k=pair(a,b);if(noDoor.has(k)||(!publicIds.has(a)&&!publicIds.has(b)&&!direct.has(k)))continue;
      const aprons=doorApron(model,wall,p,width,settings.doorDepth);if(!sides.every(id=>aprons.some(a=>a.roomId===id)))continue;
      const list=options.get(k)??[];
      for(const apron of aprons.filter(a=>!publicIds.has(a.roomId)).concat(aprons))for(const hinge of ['start','end'] as const) {
        const footprint=swingFootprint(model,wall,p,width,apron.side,hinge);
        if(!doorSwingFits(model,wall,footprint,apron.roomId)||fixedSwings.some(s=>swingCollision(footprint,s,scale)))continue;
        if(!list.some(o=>Math.abs(o.p-p)<1e-7&&o.side===apron.side&&o.hinge===hinge))list.push({a,b,wall,p,side:apron.side,hinge,footprint});
      }
      options.set(k,list);
    }
  }
  for(const opening of model.openings.filter(o=>!o.generatedBy)) {
    const wall=model.walls.find(w=>w.id===opening.hostWallId)!,sides=openingRoomSides(model,wall,opening.position,opening.width);
    if(sides.length!==2){errors.push(`固定洞口 ${opening.id} 被切分或未完整关联空间`);continue;}
    const door=model.doors.find(d=>d.openingId===opening.id);if(!door)continue;
    const aprons=doorApron(model,wall,opening.position,opening.width,settings.doorDepth);
    if(!sides.filter(s=>s!=='outside').every(id=>aprons.some(a=>a.roomId===id))){errors.push(`固定门 ${door.id} 门前缺少${settings.doorDepth.toFixed(2)}m净空`);continue;}
    fixedEdges.push([sides[0],sides[1]]);if(sides.includes('outside'))entry.set(`entrance:${door.id}`,sides.find(s=>s!=='outside')!);
  }
  const reach=(edges:[string,string][],start:string,end?:string,publicOnly=false)=> {
    const seen=new Set([start]),queue=[start];for(let i=0;i<queue.length;i++)for(const [a,b] of edges){const next=a===queue[i]?b:b===queue[i]?a:undefined;if(next&&!seen.has(next)&&(!publicOnly||next===end||publicIds.has(next))){seen.add(next);queue.push(next);}}return seen;
  };
  const hardDirect=brief.relations.filter(r=>r.kind==='direct'&&r.priority==='hard'&&!r.from.startsWith('entrance:')&&!r.to.startsWith('entrance:'));
  const publicGoals=brief.relations.filter(r=>r.kind==='public_access'&&r.priority==='hard').map(r=>({a:entry.get(r.from)??r.from,b:entry.get(r.to)??r.to}));
  let visits=0,best:Option[]|undefined;
  function choose(selected:Option[]):boolean {
    if(++visits>4000)return false;
    const edges:[string,string][]=[...fixedEdges,...selected.map(o=>[o.a,o.b] as [string,string])],keys=new Set(edges.map(([a,b])=>pair(a,b)));
    const missing=hardDirect.find(r=>!keys.has(pair(r.from,r.to)));
    let candidates:Option[]=[];
    if(missing)candidates=options.get(pair(missing.from,missing.to))??[];
    else {
      const goal=publicGoals.find(g=>!reach(edges,g.a,g.b,true).has(g.b));
      const unmet=brief.rooms.find(r=>!reach(edges,'outside').has(r.id));
      if(!goal&&!unmet){best=selected;return true;}
      const start=goal?.a??'outside',end=goal?.b??unmet!.id,seen=reach(edges,start,end,!!goal);
      candidates=[...options.values()].flat().filter(o=>!keys.has(pair(o.a,o.b))&&((seen.has(o.a)&&!seen.has(o.b)&&(!goal||o.b===end||publicIds.has(o.b)))||(seen.has(o.b)&&!seen.has(o.a)&&(!goal||o.a===end||publicIds.has(o.a)))));
      candidates.sort((a,b)=>Number(b.a===end||b.b===end)-Number(a.a===end||a.b===end));
    }
    for(const option of candidates) {
      if(visits>4000)return false;
      if(selected.some(o=>swingCollision(option.footprint,o.footprint,scale)))continue;
      if(choose([...selected,option]))return true;
    }
    return false;
  }
  const possible:[string,string][]=[...fixedEdges,...[...options.values()].filter(v=>v.length).map(v=>[v[0].a,v[0].b] as [string,string])];
  const feasible=hardDirect.every(r=>possible.some(([a,b])=>pair(a,b)===pair(r.from,r.to)))&&brief.rooms.every(r=>reach(possible,'outside').has(r.id))&&publicGoals.every(g=>reach(possible,g.a,g.b,true).has(g.b));
  if(feasible)choose([]);
  const selected=best??[],edges:[string,string][]=[...fixedEdges,...selected.map(o=>[o.a,o.b] as [string,string])],doors=new Set(edges.map(([a,b])=>pair(a,b)));
  if(!best)errors.push(visits>4000?'门位组合搜索达到预算，未找到满足关系的门位组合':'未找到满足连接与穿行许可的门位组合');
  for(const option of selected) {
    const id=`solver-door-${model.doors.length}`,openingId=`solver-opening-${model.openings.length}`;
    model.openings.push({id:openingId,hostWallId:option.wall.id,position:option.p,width,height:Math.min(2.1*scale,option.wall.height),sillHeight:0,fillRef:id,generatedBy:option.wall.generatedBy??'layout-v2'});
    model.doors.push({id,openingId,swing:option.hinge==='start'?'left':'right',hinge:option.hinge,opensTo:option.side,analysisProperties:{}});
  }
  for(const room of brief.rooms)if(!reach(edges,'outside').has(room.id))errors.push(`${room.name} 无入户通路`);
  for(const relation of brief.relations) {
    const entryFrom=entry.get(relation.from),entryTo=entry.get(relation.to),a=entryFrom??relation.from,b=entryTo??relation.to;
    const met=relation.kind==='direct'?(entryFrom||entryTo?a===b:doors.has(pair(a,b))):relation.kind==='adjacent'?adjacency.has(pair(a,b)):relation.kind==='no_direct'?!doors.has(pair(a,b)):reach(edges,a,b,true).has(b);
    const message=`关系 ${relation.id}（${relation.kind}）${met?'满足':'未满足'}`;if(met)checks.push(message);else(relation.priority==='hard'?errors:warnings).push(message);
  }
  return {errors:[...new Set(errors)],warnings,checks};
}


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
  const swingAreas:{id:string;boundary:Vec2[]}[]=[],neighbours=new Map<string,Set<string>>([...model.spaces.map(s=>s.id),'outside'].map(id=>[id,new Set<string>()]));
  for(const door of model.doors) {
    const o=model.openings.find(o=>o.id===door.openingId)!,wall=model.walls.find(w=>w.id===o.hostWallId)!;
    if(o.generatedBy&&(door.swing==='none'||!door.opensTo))errors.push(`新增门 ${door.id} 未定义门扇开启方向`);
    const sides=openingRoomSides(model,wall,o.position,o.width),apr=doorApron(model,wall,o.position,o.width,settings.doorDepth);
    if(!sides.filter(s=>s!=='outside').every(id=>apr.some(a=>a.roomId===id)))errors.push(`门 ${door.id} 缺少${settings.doorDepth.toFixed(2)}m门前净空或无法进入房间主体`);
    if(sides.length===2)for(const id of sides)neighbours.get(id)?.add(sides.find(s=>s!==id)!);
    if(door.swing!=='none'&&door.opensTo){const boundary=swingFootprint(model,wall,o.position,o.width,door.opensTo,door.hinge??'start');const target=apr.find(a=>a.side===door.opensTo);if(!target||!doorSwingFits(model,wall,boundary,target.roomId))errors.push(`门 ${door.id} 门扇碰撞墙体或越出目标房间`);for(const old of swingAreas)if(swingCollision(boundary,old.boundary,scale))errors.push(`门扇开启冲突：${door.id} 与 ${old.id}`);swingAreas.push({id:door.id,boundary});}
  }
  let penalty=rooms.reduce((n,r)=>n+r.penalty,0);
  const circulation=rooms.find(r=>r.id===CIRCULATION);
  let circulationReview: {area:number;servedRoomIds:string[];redundant:boolean}|undefined;
  if(circulation){
    const connected=[...(neighbours.get(CIRCULATION)??[])];
    const privateIds=connected.filter(id=>brief.rooms.some(r=>r.id===id&&!permitsThrough(r)));
    const reachableWithout=(target:string)=>{const reached=new Set(['outside']),queue=['outside'];for(let i=0;i<queue.length;i++)for(const next of neighbours.get(queue[i])??[]){if(next===CIRCULATION||reached.has(next))continue;const requirement=brief.rooms.find(r=>r.id===next);if(next!==target&&next!=='outside'&&(!requirement||!permitsThrough(requirement)))continue;reached.add(next);queue.push(next);}return reached.has(target);};
    const redundant=!connected.includes('outside')&&privateIds.every(reachableWithout);
    circulationReview={area:circulation.area,servedRoomIds:privateIds,redundant};
    if(redundant){penalty+=1+circulation.area*.1;warnings.push('公共交通区移除后仍可到达其服务房间，存在重复交通面积');}
    penalty+=circulation.area/Math.max(1,rooms.reduce((n,r)=>n+r.area,0))*.5;
  }
  penalty+=model.walls.filter(w=>w.generatedBy).reduce((n,w)=>n+Math.hypot(w.geometry.points[1][0]-w.geometry.points[0][0],w.geometry.points[1][1]-w.geometry.points[0][1])/scale,0)*.01;
  return {errors:[...new Set(errors)],warnings,rooms,circulation:circulationReview,penalty,thresholds:{routeWidth:settings.passageWidth,doorDepth:settings.doorDepth,doorWidth:settings.doorWidth,gridStep:.12},method:'clearance-grid-and-door-aprons'};
}
