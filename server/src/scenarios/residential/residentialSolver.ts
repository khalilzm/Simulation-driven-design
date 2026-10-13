import { diff, intersection, type Geometry } from 'martinez-polygon-clipping';
import { pointInOrOnPolygon, polygonGeometryError, type ResidentialBrief, type SpaceModel, type Vec2, type Wall, roomDaylight, layoutSettings } from '@sdd/shared';
import { boundsOf, pointAlongWallPolyline, polygonArea } from '../../geometry/polygon';
import { cleanRing, geometryArea, polygons, rectangle } from '../../geometry/regions';
import { openingFacesOutside, openingRoomSides } from '../../geometry/openingSides';
import { footprint } from '../../geometry/wallFootprint';
import { assessRoomQuality, structuralGapErrors, type RoomQuality } from './residentialQuality';
import { CIRCULATION, type PartitionStrategy, type ResidentialStrategy, type LegacyResidentialStrategy } from './residentialStrategy';
import { connectAndCheck } from './residentialConnections';
import { assessResidentialQuality } from './residentialCandidateQuality';
import { ResidentialSolveError } from './residentialErrors';
import { solveResidentialGrid } from './residentialGrid';

// Preserve existing replay/tool imports while production callers use the owning modules.
export { openingRoomSides } from '../../geometry/openingSides';
export { footprint } from '../../geometry/wallFootprint';
export { connectAndCheck } from './residentialConnections';
export { assessResidentialQuality } from './residentialCandidateQuality';
export { ResidentialSolveError } from './residentialErrors';

interface Solution { rooms: {id:string;boundary:Vec2[]}[]; walls: Wall[]; score:number }
const idsOf = (t:PartitionStrategy):string[] => 'roomId' in t ? [t.roomId] : [...idsOf(t.first),...idsOf(t.second)];

export function solveResidentialLayout(base:SpaceModel,brief:ResidentialBrief,strategy:ResidentialStrategy,revisionId:string,options:{candidateLimit?:number}={}) {
  return strategy.schemaVersion===2 ? solveResidentialGrid(base,brief,strategy,revisionId,options) : solveLegacyResidentialLayout(base,brief,strategy,revisionId);
}

/** Bounded beam search over metric cut positions; strategy controls topology, never room vertices. */
function solveLegacyResidentialLayout(base: SpaceModel, brief: ResidentialBrief, strategy: LegacyResidentialStrategy, revisionId: string) {
  const scale=base.model.units==='mm'?1000:1;
  const thickness=layoutSettings(brief).partitionThickness*scale;
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
      if((room&&roomDaylight(room).enabled)||room?.window==='preferred') score+=windows.length?-.5:1;
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
