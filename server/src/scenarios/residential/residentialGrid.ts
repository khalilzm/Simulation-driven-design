import { diff, intersection, union, type Geometry } from 'martinez-polygon-clipping';
import { layoutSettings, permitsThrough, pointInOrOnPolygon, resolveWallJunctions, roomDaylight, type ResidentialBrief, type RoomRequirement, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { boundsOf, polygonArea, pointAlongWallPolyline } from '../../geometry/polygon';
import { cleanRing, geometryArea, polygons, rectangle, sharedSegments } from '../../geometry/regions';
import { footprint } from '../../geometry/wallFootprint';
import { connectAndCheck } from './residentialConnections';
import { assessResidentialQuality } from './residentialCandidateQuality';
import { ResidentialSolveError } from './residentialErrors';
import { CIRCULATION, type IntentResidentialStrategy } from './residentialStrategy';
import { openingFacesOutside } from '../../geometry/openingSides';
import { rectangleAlignmentOffset } from './wallAlignment';
import { connectPartitionsToStructure } from '../../design/structuralWallConnections';

interface Region { id:string; boundary:Vec2[] }
interface Placement { x0:number;x1:number;y0:number;y1:number;boundary:Vec2[];score:number;windowIds:string[] }
interface PublicCore {boundary:Vec2[];area:number;score:number}

function diverseCandidates<T>(ranked:T[],key:(value:T)=>string,limit:number):T[] {
  const counts=new Map<string,number>(),selected:T[]=[];
  for(const value of ranked) {
    const bucket=key(value),count=counts.get(bucket)??0;
    if(count>=2)continue;counts.set(bucket,count+1);selected.push(value);
    if(selected.length===limit)return selected;
  }
  const kept=new Set(selected);
  for(const value of ranked)if(!kept.has(value)){selected.push(value);if(selected.length===limit)break;}
  return selected;
}

/** Wall relationships and public shape precede area/window preferences in final retention. */
export function compareResidentialScores(a:{wallRelationships:number;wallAlignment?:number;publicFragmentation:number;preferences:number},b:{wallRelationships:number;wallAlignment?:number;publicFragmentation:number;preferences:number}):number {
  // Ignore centimetre-scale junction noise and <2% changes in rectangular core ratio.
  return Math.round(a.wallRelationships/.05)-Math.round(b.wallRelationships/.05)
    || Math.round((a.wallAlignment??0)/.02)-Math.round((b.wallAlignment??0)/.02)
    || Math.round(a.publicFragmentation/.02)-Math.round(b.publicFragmentation/.02)
    || a.preferences-b.preferences;
}
/** Exact obstacle faces enrich the coarse grid. Cells never bridge a fixed wall. */
export function buildResidentialGrid(base:SpaceModel, step:number) {
  const scale=base.model.units==='mm'?1000:1;
  if(base.walls.some(w=>w.geometry.points.some((p,i,ps)=>i>0&&Math.abs(p[0]-ps[i-1][0])>1e-7&&Math.abs(p[1]-ps[i-1][1])>1e-7)) || base.floor.boundary.some((p,i,ps)=>i>0&&Math.abs(p[0]-ps[i-1][0])>1e-7&&Math.abs(p[1]-ps[i-1][1])>1e-7))throw new ResidentialSolveError('网格第一阶段支持正交住宅轮廓与墙体；此底图含斜边',{status:'unsupported_geometry'});
  let usable:Geometry=[base.floor.boundary];
  for(const w of base.walls)for(let i=1;i<w.geometry.points.length;i++)usable=diff(usable,[footprint(w,w.geometry.points[i-1],w.geometry.points[i])])??[];
  const b=boundsOf(polygons(usable).flat(2));if(!b)throw new ResidentialSolveError('固定墙体之外没有可用空间',{status:'infeasible_input'});
  const coordinates=(axis:0|1)=> {
    const lo=axis===0?b.minX:b.minY,hi=axis===0?b.maxX:b.maxY;
    const values=[lo,hi,...polygons(usable).flat(2).map(p=>p[axis])];
    for(let v=lo+step*scale;v<hi-1e-6;v+=step*scale)values.push(v);
    return [...new Set(values.map(v=>Math.round(v*1e6)/1e6))].sort((a,b)=>a-b);
  };
  const xs=coordinates(0),ys=coordinates(1),nx=xs.length-1,ny=ys.length-1;
  if(nx*ny>15000)throw new ResidentialSolveError('底图超过当前网格规模，请增大网格尺寸',{status:'grid_budget',cells:nx*ny});
  const blocked=new Int32Array((nx+1)*(ny+1));let freeCells=0;
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
    const ring=rectangle(xs[x],ys[y],xs[x+1],ys[y+1]);
    const area=(xs[x+1]-xs[x])*(ys[y+1]-ys[y]);
    const full=Math.abs(geometryArea(intersection(usable,[ring]))-area)<1e-7*scale**2;
    if(full)freeCells++;
    blocked[(y+1)*(nx+1)+x+1]=(full?0:1)+blocked[y*(nx+1)+x+1]+blocked[(y+1)*(nx+1)+x]-blocked[y*(nx+1)+x];
  }
  const clear=(x0:number,y0:number,x1:number,y1:number)=>blocked[y1*(nx+1)+x1]-blocked[y0*(nx+1)+x1]-blocked[y1*(nx+1)+x0]+blocked[y0*(nx+1)+x0]===0;
  return {xs,ys,nx,ny,clear,usable,scale,bounds:b,freeCells};
}

/** Joint bounded search: every complete allocation is checked with actual doors before retention. */
export function solveResidentialGrid(base:SpaceModel,brief:ResidentialBrief,strategy:IntentResidentialStrategy,revisionId:string,options:{candidateLimit?:number}={}) {
  const deadline=Date.now()+20000;
  const settings=layoutSettings(brief),grid=buildResidentialGrid(base,settings.gridSize),{xs,ys,nx,ny,scale,usable,bounds:b}=grid;
  const thickness=settings.partitionThickness*scale,available=geometryArea(usable)/scale**2;
  const publicRooms=brief.rooms.filter(permitsThrough),living=publicRooms.find(r=>r.kind==='living')??publicRooms[0];
  if(!living)throw new ResidentialSolveError('当前网格阶段需要至少一个允许穿行的入口空间；请在节点中设置穿行许可',{status:'unsupported_program'});
  const privateRooms=brief.rooms.filter(r=>r.id!==living.id);
  const placementBucket=(p:Placement)=>`${Math.floor(((xs[p.x0]+xs[p.x1])/2-b.minX)/(2*scale))}:${Math.floor(((ys[p.y0]+ys[p.y1])/2-b.minY)/(2*scale))}:${p.windowIds.join(',')}`;
  const structural=base.walls.filter(w=>w.fixed&&w.role==='structural'&&!openingFacesOutside(w,w.geometry.points[0],w.geometry.points.at(-1)!,base.floor.boundary));
  const assets=base.openings.map(o=> {
    const wall=base.walls.find(w=>w.id===o.hostWallId)!;
    const a=pointAlongWallPolyline(wall.geometry.points,o.position-o.width/2)!,z=pointAlongWallPolyline(wall.geometry.points,o.position+o.width/2)!;
    const l=Math.hypot(z[0]-a[0],z[1]-a[1]),offset=wall.thickness/2+.00001*scale;
    const probes=[-1,1].map(sign=>[.001,.5,.999].map(t=>[a[0]+(z[0]-a[0])*t-sign*(z[1]-a[1])/l*offset,a[1]+(z[1]-a[1])*t+sign*(z[0]-a[0])/l*offset] as Vec2)).filter(ps=>ps.every(p=>polygons(usable).some(r=>pointInOrOnPolygon(p,r[0])&&!r.slice(1).some(h=>pointInOrOnPolygon(p,h)))));
    const window=base.windows.find(w=>w.openingId===o.id),door=base.doors.find(d=>d.openingId===o.id);
    const relation=door&&brief.relations.find(r=>r.kind==='direct'&&r.priority==='hard'&&[r.from,r.to].includes(`entrance:${door.id}`));
    const owner=relation?(relation.from.startsWith('entrance:')?relation.to:relation.from):undefined;
    return {id:o.id,windowId:window?.id,windowWidth:window?.id?o.width:0,door:!!door,owner,probes};
  });
  const totalTarget=brief.rooms.reduce((n,r)=>n+r.area.target,0),uplift=Math.min(1.4,available/(totalTarget+4));
  const choices=new Map<string,Placement[]>();
  const placementKey=(p:Placement)=>`${p.x0}:${p.x1}:${p.y0}:${p.y1}`;
  const placementBounds=(p:Placement)=>({minX:xs[p.x0],maxX:xs[p.x1],minY:ys[p.y0],maxY:ys[p.y1]});
  const validPlacements=new Map<string,Map<string,Placement>>();
  for(const room of privateRooms) {
    const list:Placement[]=[],pref=strategy.preferences.find(p=>p.roomId===room.id),target=Math.min(room.area.max,room.area.target*uplift);
    for(let y0=0;y0<ny;y0++)for(let y1=y0+1;y1<=ny;y1++) {
      if(Date.now()>deadline)throw new ResidentialSolveError('网格候选构造达到20秒预算，请调整网格或简化需求',{status:'time_budget',searchLimitReached:true});
      const h=(ys[y1]-ys[y0])/scale;if(h<settings.passageWidth)continue;
      for(let x0=0;x0<nx;x0++)for(let x1=x0+1;x1<=nx;x1++) {
        const w=(xs[x1]-xs[x0])/scale;if(w<settings.passageWidth)continue;
        const area=w*h,estimatedNet=area-settings.partitionThickness/2*(2*w+2*h);
        if(estimatedNet<room.area.min||area>room.area.max+settings.partitionThickness*(w+h)||!grid.clear(x0,y0,x1,y1))continue;
        if(room.bodySize&&!((w>=room.bodySize[0]+settings.partitionThickness&&h>=room.bodySize[1]+settings.partitionThickness)||(h>=room.bodySize[0]+settings.partitionThickness&&w>=room.bodySize[1]+settings.partitionThickness)))continue;
        const ring=rectangle(xs[x0],ys[y0],xs[x1],ys[y1]);
        const edgeGaps=[xs[x0]-b.minX,b.maxX-xs[x1],ys[y0]-b.minY,b.maxY-ys[y1]];
        if(edgeGaps.some(g=>g>1e-6&&g<(settings.passageWidth+settings.partitionThickness)*scale))continue;
        const nearStructural=base.walls.filter(w=>w.fixed&&w.role==='structural').some(w=>{
          const a=w.geometry.points[0],z=w.geometry.points.at(-1)!;
          if(Math.abs(a[0]-z[0])<1e-7&&Math.min(ys[y1],Math.max(a[1],z[1]))-Math.max(ys[y0],Math.min(a[1],z[1]))>scale){
            const gap=xs[x1]<=a[0]?a[0]-w.thickness/2-xs[x1]:xs[x0]>=a[0]?xs[x0]-a[0]-w.thickness/2:0;
            return gap>1e-6&&gap<(settings.passageWidth+settings.partitionThickness)*scale;
          }
          if(Math.abs(a[1]-z[1])<1e-7&&Math.min(xs[x1],Math.max(a[0],z[0]))-Math.max(xs[x0],Math.min(a[0],z[0]))>scale){
            const gap=ys[y1]<=a[1]?a[1]-w.thickness/2-ys[y1]:ys[y0]>=a[1]?ys[y0]-a[1]-w.thickness/2:0;
            return gap>1e-6&&gap<(settings.passageWidth+settings.partitionThickness)*scale;
          }return false;
        });
        if(nearStructural)continue;
        const inside=(p:Vec2)=>pointInOrOnPolygon(p,ring,1e-8);
        const safeInside=(p:Vec2)=>p[0]>=xs[x0]+(xs[x0]>b.minX+1e-6?thickness/2:0)-1e-8&&p[0]<=xs[x1]-(xs[x1]<b.maxX-1e-6?thickness/2:0)+1e-8&&p[1]>=ys[y0]+(ys[y0]>b.minY+1e-6?thickness/2:0)-1e-8&&p[1]<=ys[y1]-(ys[y1]<b.maxY-1e-6?thickness/2:0)+1e-8;
        let invalid=false;const windows:string[]=[];let windowWidth=0;
        for(const asset of assets)for(const probes of asset.probes) {
          const flags=probes.map(inside);
          if(flags.some(Boolean)&&!flags.every(Boolean)){invalid=true;break;}
          if(flags.every(Boolean)){if(!probes.every(safeInside)){invalid=true;break;}if(asset.door&&asset.owner!==room.id){invalid=true;break;}if(asset.windowId){windows.push(asset.windowId);windowWidth+=asset.windowWidth;}}
        }
        if(invalid||(room.window==='required'&&!windows.length))continue;
        let score=((estimatedNet-target)/target)**2+.04*Math.max(w/h,h/w)+.08*edgeGaps.filter(g=>g>1e-6).length;
        if(room.window==='preferred'&&!windows.length)score+=.2;
        const daylight=roomDaylight(room);
        if(daylight.enabled) {
          // Pre-simulation daylight proxy: an exterior window serves a shallow
          // band of the room. Larger windows and smaller depth make it more
          // likely that the requested illuminated-area ratio is achievable.
          const depth=Math.min(w,h);
          const proxyRatio=Math.min(1,windowWidth*depth/Math.max(estimatedNet,1e-6));
          const targetRatio=daylight.minAreaRatio;
          score+=Math.max(0,targetRatio-proxyRatio)*1.8;
          score+=Math.max(0,depth-3)*.08;
          if(!windows.length)score+=daylight.priority==='hard'?4:1.2;
        }
        if(pref?.windowId&&!windows.includes(pref.windowId))score+=.3;
        if(pref?.side) {
          const world={north:[0,1],south:[0,-1],east:[1,0],west:[-1,0]}[pref.side],angle=brief.sunlight.northDegrees*Math.PI/180;
          const dx=world[0]*Math.cos(angle)-world[1]*Math.sin(angle),dy=world[0]*Math.sin(angle)+world[1]*Math.cos(angle);
          score-=.15*((xs[x0]+xs[x1]-b.minX-b.maxX)/(b.maxX-b.minX)*dx+(ys[y0]+ys[y1]-b.minY-b.maxY)/(b.maxY-b.minY)*dy);
        }
        // Prefer room boundaries that actually use the fixed wall faces, not only avoid them.
        for(const wall of structural) {
          const a=wall.geometry.points[0],z=wall.geometry.points.at(-1)!;
          const vertical=Math.abs(a[0]-z[0])<1e-7;
          const at=a[vertical?0:1],lo=Math.min(a[vertical?1:0],z[vertical?1:0]),hi=Math.max(a[vertical?1:0],z[vertical?1:0]);
          const faces=vertical?[xs[x0],xs[x1]]:[ys[y0],ys[y1]];
          if(faces.some(v=>Math.abs(Math.abs(v-at)-wall.thickness/2)<1e-7)) {
            const overlap=Math.max(0,Math.min(hi,vertical?ys[y1]:xs[x1])-Math.max(lo,vertical?ys[y0]:xs[x0]));
            score-=.35*overlap/scale;
          }
        }
        list.push({x0,x1,y0,y1,boundary:ring,score,windowIds:windows});
      }
    }
    list.sort((a,b)=>a.score-b.score);
    validPlacements.set(room.id,new Map(list.map(p=>[placementKey(p),p])));
    // Keep options from every spatial bucket; local area score must not erase alternative door topology.
    const buckets=new Map<string,Placement[]>();for(const p of list){const key=`${Math.floor((p.x0+p.x1)/6)}:${Math.floor((p.y0+p.y1)/6)}`;const bucket=buckets.get(key)??[];if(bucket.length<30)bucket.push(p);buckets.set(key,bucket);}
    choices.set(room.id,[...buckets.values()].flat().sort((a,b)=>a.score-b.score));
    if(!list.length)throw new ResidentialSolveError(`${room.name} 在障碍网格上没有满足面积与固定窗的候选区域`,{status:'no_room_candidate',roomId:room.id,gridSize:settings.gridSize});
  }
  // Reserve public bodies before placing the other rooms. Their positions come from the
  // obstacle grid; no fixture coordinates or new hard furniture sizes are introduced.
  const cores:PublicCore[]=[];
  const coreTarget=Math.min(living.area.target*.5,available-privateRooms.reduce((n,r)=>n+r.area.min,0));
  for(let y0=0;y0<ny;y0++)for(let y1=y0+1;y1<=ny;y1++)for(let x0=0;x0<nx;x0++)for(let x1=x0+1;x1<=nx;x1++) {
    if(Date.now()>deadline)throw new ResidentialSolveError('公共空间主体构造达到20秒预算',{status:'time_budget',searchLimitReached:true});
    const w=(xs[x1]-xs[x0]-thickness)/scale,h=(ys[y1]-ys[y0]-thickness)/scale,area=w*h;
    if(w<settings.passageWidth||h<settings.passageWidth||area>living.area.max||!grid.clear(x0,y0,x1,y1))continue;
    if(living.bodySize&&!((w>=living.bodySize[0]&&h>=living.bodySize[1])||(h>=living.bodySize[0]&&w>=living.bodySize[1])))continue;
    const boundary=rectangle(xs[x0]+thickness/2,ys[y0]+thickness/2,xs[x1]-thickness/2,ys[y1]-thickness/2);
    const score=((area-coreTarget)/Math.max(coreTarget,1))**2+.08*Math.max(w/h,h/w);
    cores.push({boundary,area,score});
  }
  cores.sort((a,b)=>a.score-b.score);
  const coreBuckets=new Map<string,PublicCore[]>();
  for(const c of cores) {
    const r=boundsOf(c.boundary)!,key=`${Math.floor(((r.minX+r.maxX)/2-b.minX)/(2*scale))}:${Math.floor(((r.minY+r.maxY)/2-b.minY)/(2*scale))}`;
    const bucket=coreBuckets.get(key)??[];if(bucket.length<2)bucket.push(c);coreBuckets.set(key,bucket);
  }
  const publicCores=[...coreBuckets.values()].flat().sort((a,b)=>a.score-b.score);
  if(!publicCores.length)throw new ResidentialSolveError(`${living.name}没有满足通行及用户主体尺寸的候选主体`,{status:'no_room_candidate',roomId:living.id});
  const hardLinks=brief.relations.filter(r=>r.priority==='hard'&&r.kind==='direct'&&!r.from.startsWith('entrance:')&&!r.to.startsWith('entrance:'));
  const linksFor=(id:string)=>hardLinks.filter(r=>r.from===id||r.to===id);
  const other=(r:typeof hardLinks[number],id:string)=>r.from===id?r.to:r.from;
  const contact=(p:Placement,q:Placement)=>{
    if(p.x1===q.x0||q.x1===p.x0)return Math.max(0,Math.min(ys[p.y1],ys[q.y1])-Math.max(ys[p.y0],ys[q.y0]));
    if(p.y1===q.y0||q.y1===p.y0)return Math.max(0,Math.min(xs[p.x1],xs[q.x1])-Math.max(xs[p.x0],xs[q.x0]));
    return 0;
  };
  // Necessary conditions only. Actual wall thickness, aprons and swings remain final checks.
  const meetsLink=(p:Placement,q:Placement,kind:string)=>contact(p,q)>=(kind==='direct'?settings.doorWidth*scale:1e-7);
  const compatible=(p:Placement,q:Placement)=>{
    if(!(p.x1<=q.x0||q.x1<=p.x0||p.y1<=q.y0||q.y1<=p.y0))return false;
    const overlapX=Math.min(xs[p.x1],xs[q.x1])-Math.max(xs[p.x0],xs[q.x0]),overlapY=Math.min(ys[p.y1],ys[q.y1])-Math.max(ys[p.y0],ys[q.y0]);
    const gapX=Math.max(xs[p.x0]-xs[q.x1],xs[q.x0]-xs[p.x1]),gapY=Math.max(ys[p.y0]-ys[q.y1],ys[q.y0]-ys[p.y1]);
    return !((overlapY>settings.passageWidth*scale&&gapX>1e-6&&gapX<(settings.passageWidth+settings.partitionThickness)*scale)||(overlapX>settings.passageWidth*scale&&gapY>1e-6&&gapY<(settings.passageWidth+settings.partitionThickness)*scale));
  };
  const fixedBounds=base.walls.flatMap(w=>w.geometry.points.slice(1).map((z,i)=>boundsOf(footprint(w,w.geometry.points[i],z))!));
  function exposedContact(p:Placement,placed:Map<string,Placement>):number {
    let longest=0;
    for(const [axis,at,lo,hi] of [[0,xs[p.x0],ys[p.y0],ys[p.y1]],[0,xs[p.x1],ys[p.y0],ys[p.y1]],[1,ys[p.y0],xs[p.x0],xs[p.x1]],[1,ys[p.y1],xs[p.x0],xs[p.x1]]]) {
      if(Math.abs(at-(axis===0?b.minX:b.minY))<1e-7||Math.abs(at-(axis===0?b.maxX:b.maxY))<1e-7)continue;
      let intervals=[[lo,hi]];
      const subtract=(low:number,high:number)=>{intervals=intervals.flatMap(([a,z])=>high<=a||low>=z?[[a,z]]:[[a,Math.max(a,low)],[Math.min(z,high),z]].filter(([a,z])=>z>a));};
      for(const wall of fixedBounds)if(at>=(axis===0?wall.minX:wall.minY)-1e-7&&at<=(axis===0?wall.maxX:wall.maxY)+1e-7)subtract(axis===0?wall.minY:wall.minX,axis===0?wall.maxY:wall.maxX);
      for(const q of placed.values())if(q!==p) {
        if(axis===0&&(Math.abs(at-xs[q.x0])<1e-7||Math.abs(at-xs[q.x1])<1e-7))subtract(ys[q.y0],ys[q.y1]);
        if(axis===1&&(Math.abs(at-ys[q.y0])<1e-7||Math.abs(at-ys[q.y1])<1e-7))subtract(xs[q.x0],xs[q.x1]);
      }
      longest=Math.max(longest,...intervals.map(([a,z])=>z-a));
    }
    return longest;
  }
  // Place the partner of an assigned hard link next, before unrelated room preferences.
  function roomOrder(alternate:boolean):RoomRequirement[] {
    const pending=[...privateRooms],ordered:RoomRequirement[]=[],assigned=new Set<string>();
    while(pending.length){pending.sort((a,b)=>linksFor(b.id).filter(r=>assigned.has(other(r,b.id))).length-linksFor(a.id).filter(r=>assigned.has(other(r,a.id))).length||(a.window==='required'?0:1)-(b.window==='required'?0:1)||(alternate?choices.get(a.id)!.length-choices.get(b.id)!.length:strategy.roomOrder.indexOf(a.id)-strategy.roomOrder.indexOf(b.id)));const next=pending.shift()!;ordered.push(next);assigned.add(next.id);}
    return ordered;
  }
  const earlyPrunes=new Map<string,number>();
  const prune=(r:typeof hardLinks[number])=>{const name=(id:string)=>brief.rooms.find(room=>room.id===id)?.name??id;const reason=`${name(r.from)}↔${name(r.to)}：${r.kind==='direct'?'未保留可开门的共享边界':'未保留共享边界'}`;earlyPrunes.set(reason,(earlyPrunes.get(reason)??0)+1);return false;};
  function acceptsPartial(id:string,p:Placement,placed:Map<string,Placement>):boolean {
    for(const q of placed.values())if(!compatible(p,q))return false;
    const next=new Map([...placed,[id,p]]);
    for(const r of hardLinks) {
      const a=next.get(r.from),z=next.get(r.to);
      if(a&&z&&!meetsLink(a,z,r.kind))return prune(r);
      const publicPartner=r.from===living.id?r.to:r.to===living.id?r.from:undefined;
      if(publicPartner){const q=next.get(publicPartner);if(q&&exposedContact(q,next)<(r.kind==='direct'?settings.doorWidth*scale:1e-7))return prune(r);}
    }
    for(const r of linksFor(id)) {
      const partner=other(r,id);if(partner===living.id||next.has(partner))continue;
      // Forward checking stops a preferred window placement from stranding its suite partner.
      if(!choices.get(partner)!.some(q=>meetsLink(p,q,r.kind)&&[...next.values()].every(a=>compatible(a,q))))return prune(r);
    }
    return true;
  }
  const failures=new Map<string,number>(),rejectedCandidates:unknown[]=[];let visits=0,complete=0,seed=271828;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const fail=(errors:string[])=>{for(const e of errors)failures.set(e,(failures.get(e)??0)+1);};
  const masks:Vec2[][]=[rectangle(b.minX-scale,b.minY-scale,b.maxX+scale,b.maxY+scale)];
  // Alternative public decompositions are inferred from obstacles, never fixed room coordinates.
  for(const wall of base.walls.filter(w=>w.fixed&&w.role==='structural')) {
    const [a,z]=[wall.geometry.points[0],wall.geometry.points.at(-1)!];
    if(Math.abs(a[0]-z[0])<1e-8&&a[0]>b.minX+.5*scale&&a[0]<b.maxX-.5*scale)masks.push(rectangle(a[0],b.minY-scale,b.maxX+scale,b.maxY+scale),rectangle(b.minX-scale,b.minY-scale,a[0],b.maxY+scale));
    if(Math.abs(a[1]-z[1])<1e-8&&a[1]>b.minY+.5*scale&&a[1]<b.maxY-.5*scale)masks.push(rectangle(b.minX-scale,a[1],b.maxX+scale,b.maxY+scale),rectangle(b.minX-scale,b.minY-scale,b.maxX+scale,a[1]));
  }
  const evaluateBase=(placed:Map<string,Placement>,core:PublicCore)=> {
    complete++;
    let best:ReturnType<typeof accepted>|undefined;
    let remaining:Geometry=usable;for(const p of placed.values())remaining=diff(remaining,[p.boundary])??[];
    for(const mask of ([...masks.slice(1),masks[0]])) {
      const main=polygons(intersection(remaining,[mask])),traffic=polygons(diff(remaining,[mask]));
      if(main.length!==1||main[0].length!==1||traffic.length>1||traffic.some(p=>p.length!==1))continue;
      // Automatic circulation is an extension of the public core.  A leftover
      // pocket behind a bedroom is not a usable route even when it is marked
      // open; require a real shared opening-width edge with the living area.
      const publicBoundary=cleanRing(main[0][0]);
      const trafficBoundary=traffic.length?cleanRing(traffic[0][0]):undefined;
      if(trafficBoundary) {
        const sharedLength=sharedSegments(publicBoundary,trafficBoundary)
          .reduce((sum,[a,z])=>sum+Math.hypot(z[0]-a[0],z[1]-a[1]),0);
        // The final door/opening validator checks the actual net width.  Here we
        // only reject a detached pocket; keeping the geometric test permissive
        // lets the solver choose a wider shared edge when one is available.
        if(sharedLength <= 1e-7*scale)continue;
      }
      if(Math.abs(geometryArea(intersection(main,[core.boundary]))-core.area*scale**2)>1e-6*scale**2)continue;
      const regions:Region[]=[...placed].map(([id,p])=>({id,boundary:p.boundary}));regions.push({id:living.id,boundary:publicBoundary});
      if(trafficBoundary&&geometryArea(traffic)/scale**2>1e-6)regions.push({id:CIRCULATION,boundary:trafficBoundary});
      const model=materialize(base,regions,brief,revisionId,thickness);
      if(!model)continue;
      if(Math.abs(geometryArea(intersection([model.spaces.find(s=>s.id===living.id)!.boundary],[core.boundary]))-core.area*scale**2)>1e-6*scale**2)continue;
      const areaErrors=brief.rooms.flatMap(r=>{const s=model.spaces.find(s=>s.id===r.id)!;const area=polygonArea(s.boundary)/scale**2;return area<r.area.min-1e-6||area>r.area.max+1e-6?[`${r.name}净面积超出范围`]:[];});
      if(areaErrors.length){fail(areaErrors);continue;}
      const check=connectAndCheck(model,brief);
      if(check.errors.length){fail(check.errors);if(rejectedCandidates.length<8)rejectedCandidates.push({spaces:model.spaces,walls:model.walls.filter(w=>!w.fixed),errors:check.errors});continue;}
      const quality=assessResidentialQuality(model,brief,{},true);
      if(model.spaces.some(s=>s.id===CIRCULATION)) {
        const connected=quality.circulation?.openConnections.some(c=>c.spaceId===living.id&&c.netWidthM>=settings.passageWidth-1e-7);
        if(!connected)continue;
      }
      const errors=[...check.errors,...quality.errors];
      if(quality.structuralConnections.mismatchCount)errors.push(...quality.structuralConnections.warnings);
      if(errors.length){fail(errors);if(rejectedCandidates.length<8)rejectedCandidates.push({spaces:model.spaces,walls:model.walls.filter(w=>!w.fixed),errors});continue;}
      const result=accepted(model,check,quality,placed,core);if(!best||compareResidentialScores(result.report.scoreComponents,best.report.scoreComponents)<0)best=result;
    }
    return best;
  };
  const alignmentCost=(placed:Map<string,Placement>)=>{
    const ps=[...placed.values()];let total=0;
    for(let i=0;i<ps.length;i++)for(let j=i+1;j<ps.length;j++)total+=rectangleAlignmentOffset(placementBounds(ps[i]),placementBounds(ps[j]),settings.passageWidth*scale)/scale;
    return total;
  };
  // Coordinate descent on room allocations, before walls and doors are rebuilt. Only
  // previously validated obstacle-grid placements may be used; every trial is fully checked.
  const evaluate=(placed:Map<string,Placement>,core:PublicCore)=>{
    let best=evaluateBase(placed,core),current=placed;
    if(!best)return;
    for(let round=0;round<3&&best.report.quality.wallAlignment.steps.length&&Date.now()<deadline;round++) {
      const entries=[...current],trials=new Map<string,Map<string,Placement>>(),c=boundsOf(core.boundary)!;
      for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++) {
        const [id,p]=entries[i],[otherId,q]=entries[j];
        if(!rectangleAlignmentOffset(placementBounds(p),placementBounds(q),settings.passageWidth*scale))continue;
        const fields:('x0'|'x1'|'y0'|'y1')[]=p.y1===q.y0||q.y1===p.y0?['x0','x1']:['y0','y1'];
        for(const field of fields) {
          const coordinates=field.startsWith('x')?xs:ys;
          const delta=Math.abs(coordinates[p[field]]-coordinates[q[field]]);
          if(delta<1e-7||delta>=settings.passageWidth*scale)continue;
          for(let at=Math.min(p[field],q[field]);at<=Math.max(p[field],q[field]);at++) {
            const a=validPlacements.get(id)!.get(placementKey({...p,[field]:at}));
            const b=validPlacements.get(otherId)!.get(placementKey({...q,[field]:at}));
            if(!a||!b)continue;
            const next=new Map([...current,[id,a],[otherId,b]]);
            if([a,b].some(s=>!(xs[s.x1]<=c.minX||xs[s.x0]>=c.maxX||ys[s.y1]<=c.minY||ys[s.y0]>=c.maxY)))continue;
            if(![...next].every(([roomId,s])=>acceptsPartial(roomId,s,new Map([...next].filter(([key])=>key!==roomId)))))continue;
            trials.set([...next].map(([key,s])=>`${key}:${placementKey(s)}`).join('|'),next);
          }
        }
      }
      const ranked=[...trials.values()].map(p=>({p,cost:alignmentCost(p)})).sort((a,b)=>a.cost-b.cost).slice(0,24);
      let improved=false,nextCurrent=current;
      for(const {p} of ranked) {
        if(Date.now()>deadline)break;
        const candidate=evaluateBase(p,core);
        if(candidate&&compareResidentialScores(candidate.report.scoreComponents,best.report.scoreComponents)<0) {
          best=candidate;nextCurrent=p;improved=true;
        }
      }
      if(!improved)break;current=nextCurrent;
    }
    return best;
  };
  function accepted(model:SpaceModel,check:ReturnType<typeof connectAndCheck>,quality:ReturnType<typeof assessResidentialQuality>,placed:Map<string,Placement>,core:PublicCore) {
      const score=[...placed.values()].reduce((n,p)=>n+p.score,0)+quality.penalty+check.warnings.length*.2+(quality.circulation&&strategy.circulation==='prefer'?-.2:0)+((polygonArea(model.spaces.find(s=>s.id===living.id)!.boundary)/scale**2-living.area.target)/living.area.target)**2;
      const scoreComponents={wallRelationships:quality.structuralWalls.unexplainedLength,wallAlignment:quality.wallAlignment.totalOffset,publicFragmentation:quality.publicSpaces.find(s=>s.spaceId===living.id)?1-quality.publicSpaces.find(s=>s.spaceId===living.id)!.coreRatio:0,preferences:score};
      return {model,report:{status:'solved',method:'obstacle-grid-allocation',gridSize:settings.gridSize,gridCells:grid.freeCells,searchVisits:visits,earlyConnectionPrunes:Object.fromEntries(earlyPrunes),searchLimitReached:false,combinationChecks:complete,candidateCount:1,score,scoreComponents,publicCore:{boundary:core.boundary,area:core.area},acceptedSpaces:model.spaces,netAvailableArea:available,rooms:model.spaces.map(s=>({id:s.id,netArea:polygonArea(s.boundary)/scale**2})),checks:check.checks,warnings:[...check.warnings,...quality.warnings],quality,qualityChecksVersion:6,rejectedCandidates,rejectedRegions:[]}};
  }
  // Randomized beam restarts preserve alternative window/door arrangements; deterministic replay.
  interface State {placed:Map<string,Placement>;score:number;core:PublicCore}
  let best:ReturnType<typeof accepted>|undefined,acceptedCount=0;
  const candidateLimit=Math.max(1,Math.min(3,options.candidateLimit??1));
  const candidatePool:ReturnType<typeof accepted>[]=[];
  const candidateKeys=new Map<string,ReturnType<typeof accepted>>();
  const retain=(result:ReturnType<typeof accepted>)=>{
    const key=JSON.stringify(result.model.spaces.filter(s=>s.id!==CIRCULATION).map(s=>{
      const bounds=boundsOf(s.boundary)!;
      return [s.id,Math.round((bounds.minX+bounds.maxX)/(1.5*scale)),Math.round((bounds.minY+bounds.maxY)/(1.5*scale))];
    }));
    const previous=candidateKeys.get(key);
    if(previous&&compareResidentialScores(result.report.scoreComponents,previous.report.scoreComponents)>=0)return;
    if(previous)candidatePool.splice(candidatePool.indexOf(previous),1);
    candidateKeys.set(key,result);candidatePool.push(result);
    candidatePool.sort((a,b)=>compareResidentialScores(a.report.scoreComponents,b.report.scoreComponents));
    if(candidatePool.length>candidateLimit){const removed=candidatePool.pop()!;for(const [storedKey,value] of candidateKeys)if(value===removed)candidateKeys.delete(storedKey);}
  };
  const finish=(winner:ReturnType<typeof accepted>)=>{
    winner.report.candidateCount=acceptedCount;winner.report.searchVisits=visits;winner.report.combinationChecks=complete;
    return {...winner,alternatives:candidatePool.map(c=>({model:c.model,report:c.report}))};
  };
  for(let restart=0;restart<32&&visits<60000&&Date.now()<deadline;restart++) {
    const core=publicCores[restart%publicCores.length];
    let beam:State[]=[{placed:new Map(),score:0,core}];
    const ordered=roomOrder(restart%2!==0);
    for(const room of ordered) {
      if(Date.now()>deadline)break;
      const next:State[]=[];
      for(const state of beam) {
        if(Date.now()>deadline)break;
        const c=boundsOf(state.core.boundary)!;
        const options=choices.get(room.id)!.filter(p=>(xs[p.x1]<=c.minX||xs[p.x0]>=c.maxX||ys[p.y1]<=c.minY||ys[p.y0]>=c.maxY)&&acceptsPartial(room.id,p,state.placed));
        const ranked=diverseCandidates(options.map(p=>({p,rank:p.score+(restart?random()*.8:0)})).sort((a,b)=>a.rank-b.rank),v=>placementBucket(v.p),24);
        for(const {p,rank} of ranked){visits++;next.push({placed:new Map([...state.placed,[room.id,p]]),score:state.score+rank,core:state.core});}
      }
      next.sort((a,b)=>a.score-b.score);beam=diverseCandidates(next,s=>[...s.placed].map(([id,p])=>`${id}:${placementBucket(p)}`).join('|'),32);if(!beam.length)break;
    }
    for(const state of beam)if(state.placed.size===privateRooms.length){const result=evaluate(state.placed,state.core);if(result){acceptedCount++;retain(result);if(!best||compareResidentialScores(result.report.scoreComponents,best.report.scoreComponents)<0)best=result;if(acceptedCount>=8&&candidatePool.length>=candidateLimit&&best.report.scoreComponents.wallRelationships<.05&&best.report.scoreComponents.wallAlignment<.02)return finish(best);}if(Date.now()>deadline)break;}
  }
  if(best){best.report.searchLimitReached=visits>=60000||Date.now()>deadline;return finish(best);}
  const reasons=[...failures,...earlyPrunes].sort((a,b)=>b[1]-a[1]).slice(0,10);
  throw new ResidentialSolveError(`网格搜索未找到可行布局，不能据此认定需求无解。${reasons.map(([r])=>r).join('；')||'房间候选无法组合或剩余公共区域不连通'}`,{status:Date.now()>deadline?'time_budget':'search_exhausted',method:'obstacle-grid-allocation',searchVisits:visits,earlyConnectionPrunes:Object.fromEntries(earlyPrunes),combinationChecks:complete,searchLimitReached:visits>=60000||Date.now()>deadline,failures:reasons.map(([reason,count])=>({reason,count})),rejectedCandidates,gridSize:settings.gridSize});
}

function materialize(base:SpaceModel,regions:Region[],brief:ResidentialBrief,revisionId:string,thickness:number):SpaceModel|undefined {
  const segments=new Map<string,{axis:0|1;at:number;lo:number;hi:number}>();
  const publicIds=new Set([CIRCULATION,...brief.rooms.filter(permitsThrough).map(r=>r.id)]);
  for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++) {
    // Automatic circulation is a public zone, not another room to enclose.
    const ids=[regions[i].id,regions[j].id];
    if(ids.includes(CIRCULATION)&&ids.every(id=>publicIds.has(id)))continue;
    for(const [a,z] of sharedSegments(regions[i].boundary,regions[j].boundary)) {
    const axis:0|1=Math.abs(a[0]-z[0])<1e-7?0:1,at=a[axis],lo=Math.min(a[1-axis],z[1-axis]),hi=Math.max(a[1-axis],z[1-axis]);
    if(hi-lo<1e-7)continue;const key=`${axis}:${at.toFixed(6)}:${lo.toFixed(6)}:${hi.toFixed(6)}`;segments.set(key,{axis,at,lo,hi});
    }
  }
  const grouped=new Map<string,{axis:0|1;at:number;lo:number;hi:number}[]>();for(const s of segments.values()){const key=`${s.axis}:${s.at.toFixed(6)}`;grouped.set(key,[...(grouped.get(key)??[]),s]);}
  const walls:Wall[]=[];
  for(const list of grouped.values()) {
    list.sort((a,b)=>a.lo-b.lo);const merged:typeof list=[];
    for(const s of list){const last=merged.at(-1);if(last&&s.lo<=last.hi+1e-7)last.hi=Math.max(last.hi,s.hi);else merged.push({...s});}
    for(const s of merged)walls.push({id:`grid-wall-${walls.length}`,geometry:{type:'polyline',points:s.axis===0?[[s.at,s.lo],[s.at,s.hi]]:[[s.lo,s.at],[s.hi,s.at]]},thickness,height:base.floor.height,fixed:false,role:'partition',generatedBy:'layout-grid-v1'});
  }
  connectPartitionsToStructure(walls,base.walls.filter(w=>w.fixed&&w.role==='structural'),base.model.units==='mm'?1000:1);
  const junctions=resolveWallJunctions([...base.walls,...walls]);
  const wallPolygons:Vec2[][]=[];
  let wallGeometry:Geometry=[];
  for(const w of walls){const polygon=junctions.get(w.id);if(!polygon)return;const ring=cleanRing(polygon);wallPolygons.push(ring);wallGeometry=wallGeometry.length?(union(wallGeometry,[ring])??[]):[ring];wallGeometry=polygons(wallGeometry).map(rings=>rings.map(cleanRing));}
  const model=structuredClone(base);model.model.revisionId=revisionId;model.model.parentRevisionId=base.model.revisionId;model.walls.push(...walls);model.spaceTypes=[];model.spaces=[];
  for(const [i,r] of regions.entries()) {
    let net:Geometry;
    try {net=wallGeometry.length?(diff([r.boundary],wallGeometry)??[]):[r.boundary];}
    catch(error) {
      // Martinez may fail to assign a hole at a shared miter vertex. Subtracting the
      // same physical wall polygons separately avoids that ambiguous union topology.
      if(!(error instanceof TypeError&&error.message.includes('holeOf')))throw error;
      net=[r.boundary];for(const polygon of wallPolygons)net=polygons(diff(net,[polygon])).map(rings=>rings.map(cleanRing));
    }
    const ps=polygons(net);if(ps.length!==1||ps[0].length!==1)return;
    const name=brief.rooms.find(room=>room.id===r.id)?.name??'交通空间';
    model.spaceTypes.push({id:`grid-type-${i}`,label:name,color:['#A8C8F0','#98D4B8','#FFE4A8','#C8B8E8','#FFB878','#88C8E8'][i%6]});
    model.spaces.push({id:r.id,allocationId:r.id,boundary:cleanRing(ps[0][0]),typeId:`grid-type-${i}`,usage:name,enclosed:r.id!==CIRCULATION,targetArea:brief.rooms.find(room=>room.id===r.id)?.area.target??polygonArea(cleanRing(ps[0][0]))/(base.model.units==='mm'?1e6:1),performancePreferences:{}});
  }
  return model;
}
