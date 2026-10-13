import { layoutSettings, permitsThrough, type ResidentialBrief, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { openingRoomSides } from '../../geometry/openingSides';
import { doorApron, doorSwingFits, swingFootprint, swingCollision } from '../../geometry/doorGeometry';
import { openSpaceConnections } from '../../geometry/openSpaceConnections';
import { CIRCULATION } from './residentialStrategy';

export function connectAndCheck(model:SpaceModel,brief:ResidentialBrief) {
  const scale=model.model.units==='mm'?1000:1,settings=layoutSettings(brief),width=settings.doorWidth*scale;
  const errors:string[]=[],warnings:string[]=[],checks:string[]=[];
  const publicIds=new Set([CIRCULATION,...brief.rooms.filter(permitsThrough).map(r=>r.id)]);
  const pair=(a:string,b:string)=>[a,b].sort().join('|');
  const noDoor=new Set(brief.relations.filter(r=>r.kind==='no_direct'&&r.priority==='hard').map(r=>pair(r.from,r.to)));
  const direct=new Set(brief.relations.filter(r=>r.kind==='direct').map(r=>pair(r.from,r.to)));
  const adjacency=new Set<string>(),fixedEdges:[string,string][]=[],entry=new Map<string,string>();
  for(const connection of openSpaceConnections(model)) {
    const key=pair(connection.from,connection.to);adjacency.add(key);
    if(connection.netWidthM+1e-7<settings.passageWidth)continue;
    if(noDoor.has(key)){errors.push(`开放通道 ${connection.from}↔${connection.to} 违反禁止直接连通关系`);continue;}
    fixedEdges.push([connection.from,connection.to]);
  }
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
      const unmet=model.spaces.find(r=>!reach(edges,'outside').has(r.id));
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
  const feasible=hardDirect.every(r=>possible.some(([a,b])=>pair(a,b)===pair(r.from,r.to)))&&model.spaces.every(r=>reach(possible,'outside').has(r.id))&&publicGoals.every(g=>reach(possible,g.a,g.b,true).has(g.b));
  if(feasible)choose([]);
  const selected=best??[],edges:[string,string][]=[...fixedEdges,...selected.map(o=>[o.a,o.b] as [string,string])],doors=new Set(edges.map(([a,b])=>pair(a,b)));
  if(!best)errors.push(visits>4000?'门位组合搜索达到预算，未找到满足关系的门位组合':'未找到满足连接与穿行许可的门位组合');
  for(const option of selected) {
    const id=`solver-door-${model.doors.length}`,openingId=`solver-opening-${model.openings.length}`;
    model.openings.push({id:openingId,hostWallId:option.wall.id,position:option.p,width,height:Math.min(2.1*scale,option.wall.height),sillHeight:0,fillRef:id,generatedBy:option.wall.generatedBy??'layout-v2'});
    model.doors.push({id,openingId,swing:option.hinge==='start'?'left':'right',hinge:option.hinge,opensTo:option.side,analysisProperties:{}});
  }
  for(const space of model.spaces)if(!reach(edges,'outside').has(space.id))errors.push(`${space.usage} 无入户通路`);
  for(const relation of brief.relations) {
    const entryFrom=entry.get(relation.from),entryTo=entry.get(relation.to),a=entryFrom??relation.from,b=entryTo??relation.to;
    const met=relation.kind==='direct'?(entryFrom||entryTo?a===b:doors.has(pair(a,b))):relation.kind==='adjacent'?adjacency.has(pair(a,b)):relation.kind==='no_direct'?!doors.has(pair(a,b)):reach(edges,a,b,true).has(b);
    const message=`关系 ${relation.id}（${relation.kind}）${met?'满足':'未满足'}`;if(met)checks.push(message);else(relation.priority==='hard'?errors:warnings).push(message);
  }
  return {errors:[...new Set(errors)],warnings,checks};
}


