import { diff, intersection, union, type Geometry } from 'martinez-polygon-clipping';
import { layoutSettings, permitsThrough, pointInOrOnPolygon, type ResidentialBrief, type RoomRequirement, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { boundsOf, polygonArea, pointAlongWallPolyline } from '../model/geometry';
import { cleanRing, geometryArea, polygons, rectangle, sharedSegments } from './regionGeometry';
import { footprint, connectAndCheck, assessResidentialQuality, ResidentialSolveError } from './residentialSolver';
import { CIRCULATION, type IntentResidentialStrategy } from './residentialStrategy';
import { assessRoomQuality } from './residentialQuality';

interface Region { id:string; boundary:Vec2[] }
interface Placement { x0:number;x1:number;y0:number;y1:number;boundary:Vec2[];score:number;windowIds:string[] }
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
export function solveResidentialGrid(base:SpaceModel,brief:ResidentialBrief,strategy:IntentResidentialStrategy,revisionId:string) {
  const deadline=Date.now()+20000;
  const settings=layoutSettings(brief),grid=buildResidentialGrid(base,settings.gridSize),{xs,ys,nx,ny,scale,usable,bounds:b}=grid;
  const thickness=.12*scale,available=geometryArea(usable)/scale**2;
  const publicRooms=brief.rooms.filter(permitsThrough),living=publicRooms.find(r=>r.kind==='living')??publicRooms[0];
  if(!living)throw new ResidentialSolveError('当前网格阶段需要至少一个允许穿行的入口空间；请在节点中设置穿行许可',{status:'unsupported_program'});
  const privateRooms=brief.rooms.filter(r=>r.id!==living.id);
  const assets=base.openings.map(o=> {
    const wall=base.walls.find(w=>w.id===o.hostWallId)!;
    const a=pointAlongWallPolyline(wall.geometry.points,o.position-o.width/2)!,z=pointAlongWallPolyline(wall.geometry.points,o.position+o.width/2)!;
    const l=Math.hypot(z[0]-a[0],z[1]-a[1]),offset=wall.thickness/2+.00001*scale;
    const probes=[-1,1].map(sign=>[.001,.5,.999].map(t=>[a[0]+(z[0]-a[0])*t-sign*(z[1]-a[1])/l*offset,a[1]+(z[1]-a[1])*t+sign*(z[0]-a[0])/l*offset] as Vec2)).filter(ps=>ps.every(p=>polygons(usable).some(r=>pointInOrOnPolygon(p,r[0])&&!r.slice(1).some(h=>pointInOrOnPolygon(p,h)))));
    const window=base.windows.find(w=>w.openingId===o.id),door=base.doors.find(d=>d.openingId===o.id);
    const relation=door&&brief.relations.find(r=>r.kind==='direct'&&r.priority==='hard'&&[r.from,r.to].includes(`entrance:${door.id}`));
    const owner=relation?(relation.from.startsWith('entrance:')?relation.to:relation.from):undefined;
    return {id:o.id,windowId:window?.id,door:!!door,owner,probes};
  });
  const totalTarget=brief.rooms.reduce((n,r)=>n+r.area.target,0),uplift=Math.min(1.4,available/(totalTarget+4));
  const choices=new Map<string,Placement[]>();
  for(const room of privateRooms) {
    const list:Placement[]=[],pref=strategy.preferences.find(p=>p.roomId===room.id),target=Math.min(room.area.max,room.area.target*uplift);
    for(let y0=0;y0<ny;y0++)for(let y1=y0+1;y1<=ny;y1++) {
      if(Date.now()>deadline)throw new ResidentialSolveError('网格候选构造达到20秒预算，请调整网格或简化需求',{status:'time_budget',searchLimitReached:true});
      const h=(ys[y1]-ys[y0])/scale;if(h<settings.passageWidth)continue;
      for(let x0=0;x0<nx;x0++)for(let x1=x0+1;x1<=nx;x1++) {
        const w=(xs[x1]-xs[x0])/scale;if(w<settings.passageWidth)continue;
        const area=w*h,estimatedNet=area-.06*(2*w+2*h);
        if(estimatedNet<room.area.min||area>room.area.max+.12*(w+h)||!grid.clear(x0,y0,x1,y1))continue;
        if(room.bodySize&&!((w>=room.bodySize[0]+.12&&h>=room.bodySize[1]+.12)||(h>=room.bodySize[0]+.12&&w>=room.bodySize[1]+.12)))continue;
        const ring=rectangle(xs[x0],ys[y0],xs[x1],ys[y1]);
        const edgeGaps=[xs[x0]-b.minX,b.maxX-xs[x1],ys[y0]-b.minY,b.maxY-ys[y1]];
        if(edgeGaps.some(g=>g>1e-6&&g<(settings.passageWidth+.12)*scale))continue;
        const nearStructural=base.walls.filter(w=>w.fixed&&w.role==='structural').some(w=>{
          const a=w.geometry.points[0],z=w.geometry.points.at(-1)!;
          if(Math.abs(a[0]-z[0])<1e-7&&Math.min(ys[y1],Math.max(a[1],z[1]))-Math.max(ys[y0],Math.min(a[1],z[1]))>scale){
            const gap=xs[x1]<=a[0]?a[0]-w.thickness/2-xs[x1]:xs[x0]>=a[0]?xs[x0]-a[0]-w.thickness/2:0;
            return gap>1e-6&&gap<(settings.passageWidth+.12)*scale;
          }
          if(Math.abs(a[1]-z[1])<1e-7&&Math.min(xs[x1],Math.max(a[0],z[0]))-Math.max(xs[x0],Math.min(a[0],z[0]))>scale){
            const gap=ys[y1]<=a[1]?a[1]-w.thickness/2-ys[y1]:ys[y0]>=a[1]?ys[y0]-a[1]-w.thickness/2:0;
            return gap>1e-6&&gap<(settings.passageWidth+.12)*scale;
          }return false;
        });
        if(nearStructural)continue;
        const inside=(p:Vec2)=>pointInOrOnPolygon(p,ring,1e-8);
        const safeInside=(p:Vec2)=>p[0]>=xs[x0]+(xs[x0]>b.minX+1e-6?thickness/2:0)-1e-8&&p[0]<=xs[x1]-(xs[x1]<b.maxX-1e-6?thickness/2:0)+1e-8&&p[1]>=ys[y0]+(ys[y0]>b.minY+1e-6?thickness/2:0)-1e-8&&p[1]<=ys[y1]-(ys[y1]<b.maxY-1e-6?thickness/2:0)+1e-8;
        let invalid=false;const windows:string[]=[];
        for(const asset of assets)for(const probes of asset.probes) {
          const flags=probes.map(inside);
          if(flags.some(Boolean)&&!flags.every(Boolean)){invalid=true;break;}
          if(flags.every(Boolean)){if(!probes.every(safeInside)){invalid=true;break;}if(asset.door&&asset.owner!==room.id){invalid=true;break;}if(asset.windowId)windows.push(asset.windowId);}
        }
        if(invalid||(room.window==='required'&&!windows.length))continue;
        let score=((estimatedNet-target)/target)**2+.04*Math.max(w/h,h/w)+.08*edgeGaps.filter(g=>g>1e-6).length;
        if(room.window==='preferred'&&!windows.length)score+=.2;
        if(pref?.windowId&&!windows.includes(pref.windowId))score+=.3;
        if(pref?.side) {
          const world={north:[0,1],south:[0,-1],east:[1,0],west:[-1,0]}[pref.side],angle=brief.sunlight.northDegrees*Math.PI/180;
          const dx=world[0]*Math.cos(angle)-world[1]*Math.sin(angle),dy=world[0]*Math.sin(angle)+world[1]*Math.cos(angle);
          score-=.15*((xs[x0]+xs[x1]-b.minX-b.maxX)/(b.maxX-b.minX)*dx+(ys[y0]+ys[y1]-b.minY-b.maxY)/(b.maxY-b.minY)*dy);
        }
        list.push({x0,x1,y0,y1,boundary:ring,score,windowIds:windows});
      }
    }
    list.sort((a,b)=>a.score-b.score);
    // Keep options from every spatial bucket; local area score must not erase alternative door topology.
    const buckets=new Map<string,Placement[]>();for(const p of list){const key=`${Math.floor((p.x0+p.x1)/6)}:${Math.floor((p.y0+p.y1)/6)}`;const bucket=buckets.get(key)??[];if(bucket.length<30)bucket.push(p);buckets.set(key,bucket);}
    choices.set(room.id,[...buckets.values()].flat().sort((a,b)=>a.score-b.score));
    if(!list.length)throw new ResidentialSolveError(`${room.name} 在障碍网格上没有满足面积与固定窗的候选区域`,{status:'no_room_candidate',roomId:room.id,gridSize:settings.gridSize});
  }
  const order=[...privateRooms].sort((a,b)=>(a.window==='required'?0:1)-(b.window==='required'?0:1)||strategy.roomOrder.indexOf(a.id)-strategy.roomOrder.indexOf(b.id));
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
  const evaluate=(placed:Map<string,Placement>)=> {
    complete++;
    let best:ReturnType<typeof accepted>|undefined;
    let remaining:Geometry=usable;for(const p of placed.values())remaining=diff(remaining,[p.boundary])??[];
    for(const mask of ([...masks.slice(1),masks[0]])) {
      const main=polygons(intersection(remaining,[mask])),traffic=polygons(diff(remaining,[mask]));
      if(main.length!==1||main[0].length!==1||traffic.length>1||traffic.some(p=>p.length!==1))continue;
      const regions:Region[]=[...placed].map(([id,p])=>({id,boundary:p.boundary}));regions.push({id:living.id,boundary:cleanRing(main[0][0])});
      if(traffic.length&&geometryArea(traffic)/scale**2>1e-6)regions.push({id:CIRCULATION,boundary:cleanRing(traffic[0][0])});
      const model=materialize(base,regions,brief,revisionId,thickness);
      if(!model)continue;
      const areaErrors=brief.rooms.flatMap(r=>{const s=model.spaces.find(s=>s.id===r.id)!;const area=polygonArea(s.boundary)/scale**2;return area<r.area.min-1e-6||area>r.area.max+1e-6?[`${r.name}净面积超出范围`]:[];});
      if(areaErrors.length){fail(areaErrors);continue;}
      const check=connectAndCheck(model,brief);
      if(check.errors.length){fail(check.errors);if(rejectedCandidates.length<8)rejectedCandidates.push({spaces:model.spaces,walls:model.walls.filter(w=>!w.fixed),errors:check.errors});continue;}
      const quality=assessResidentialQuality(model,brief,{},true);
      const errors=[...check.errors,...quality.errors];
      if(errors.length){fail(errors);if(rejectedCandidates.length<8)rejectedCandidates.push({spaces:model.spaces,walls:model.walls.filter(w=>!w.fixed),errors});continue;}
      const result=accepted(model,check,quality,placed);if(!best||result.report.score<best.report.score)best=result;
    }
    return best;
  };
  function accepted(model:SpaceModel,check:ReturnType<typeof connectAndCheck>,quality:ReturnType<typeof assessResidentialQuality>,placed:Map<string,Placement>) {
      return {model,report:{status:'solved',method:'obstacle-grid-allocation',gridSize:settings.gridSize,gridCells:grid.freeCells,searchVisits:visits,searchLimitReached:false,combinationChecks:complete,candidateCount:1,score:[...placed.values()].reduce((n,p)=>n+p.score,0)+quality.penalty+check.warnings.length*.2+(quality.circulation&&strategy.circulation==='prefer'?-.2:0)+((polygonArea(model.spaces.find(s=>s.id===living.id)!.boundary)/scale**2-living.area.target)/living.area.target)**2,netAvailableArea:available,rooms:model.spaces.map(s=>({id:s.id,netArea:polygonArea(s.boundary)/scale**2})),checks:check.checks,warnings:[...check.warnings,...quality.warnings],quality,qualityChecksVersion:2,rejectedCandidates,rejectedRegions:[]}};
  }
  // Randomized beam restarts preserve alternative window/door arrangements; deterministic replay.
  interface State {placed:Map<string,Placement>;score:number}
  let best:ReturnType<typeof accepted>|undefined,acceptedCount=0;
  for(let restart=0;restart<32&&visits<60000&&Date.now()<deadline;restart++) {
    let beam:State[]=[{placed:new Map(),score:0}];
    const ordered=restart%2===0?order:[...order].sort((a,b)=>(a.window==='required'?0:1)-(b.window==='required'?0:1)||choices.get(a.id)!.length-choices.get(b.id)!.length);
    for(const room of ordered) {
      const next:State[]=[];
      for(const state of beam) {
        const options=choices.get(room.id)!.filter(p=>[...state.placed.values()].every(q=>{
          if(!(p.x1<=q.x0||q.x1<=p.x0||p.y1<=q.y0||q.y1<=p.y0))return false;
          const overlapX=Math.min(xs[p.x1],xs[q.x1])-Math.max(xs[p.x0],xs[q.x0]),overlapY=Math.min(ys[p.y1],ys[q.y1])-Math.max(ys[p.y0],ys[q.y0]);
          const gapX=Math.max(xs[p.x0]-xs[q.x1],xs[q.x0]-xs[p.x1]),gapY=Math.max(ys[p.y0]-ys[q.y1],ys[q.y0]-ys[p.y1]);
          return !((overlapY>settings.passageWidth*scale&&gapX>1e-6&&gapX<(settings.passageWidth+.12)*scale)||(overlapX>settings.passageWidth*scale&&gapY>1e-6&&gapY<(settings.passageWidth+.12)*scale));
        }));
        const ranked=options.map(p=>({p,rank:p.score+(restart?random()*.8:0)})).sort((a,b)=>a.rank-b.rank).slice(0,32);
        for(const {p,rank} of ranked){visits++;next.push({placed:new Map([...state.placed,[room.id,p]]),score:state.score+rank});}
      }
      next.sort((a,b)=>a.score-b.score);beam=next.slice(0,48);if(!beam.length)break;
    }
    for(const state of beam)if(state.placed.size===privateRooms.length){const result=evaluate(state.placed);if(result){acceptedCount++;if(!best||result.report.score<best.report.score)best=result;if(acceptedCount>=8){best.report.candidateCount=acceptedCount;best.report.searchVisits=visits;best.report.combinationChecks=complete;return best;}}if(Date.now()>deadline)break;}
  }
  if(best){best.report.candidateCount=acceptedCount;best.report.searchVisits=visits;best.report.combinationChecks=complete;best.report.searchLimitReached=visits>=60000||Date.now()>deadline;return best;}
  const reasons=[...failures].sort((a,b)=>b[1]-a[1]).slice(0,10);
  throw new ResidentialSolveError(`网格搜索未找到可行布局，不能据此认定需求无解。${reasons.map(([r])=>r).join('；')||'房间候选无法组合或剩余公共区域不连通'}`,{status:Date.now()>deadline?'time_budget':'search_exhausted',method:'obstacle-grid-allocation',searchVisits:visits,combinationChecks:complete,searchLimitReached:visits>=60000||Date.now()>deadline,failures:reasons.map(([reason,count])=>({reason,count})),rejectedCandidates,gridSize:settings.gridSize});
}

function materialize(base:SpaceModel,regions:Region[],brief:ResidentialBrief,revisionId:string,thickness:number):SpaceModel|undefined {
  const segments=new Map<string,{axis:0|1;at:number;lo:number;hi:number}>();
  for(let i=0;i<regions.length;i++)for(let j=i+1;j<regions.length;j++)for(const [a,z] of sharedSegments(regions[i].boundary,regions[j].boundary)) {
    const axis:0|1=Math.abs(a[0]-z[0])<1e-7?0:1,at=a[axis],lo=Math.min(a[1-axis],z[1-axis]),hi=Math.max(a[1-axis],z[1-axis]);
    if(hi-lo<1e-7)continue;const key=`${axis}:${at.toFixed(6)}:${lo.toFixed(6)}:${hi.toFixed(6)}`;segments.set(key,{axis,at,lo,hi});
  }
  const grouped=new Map<string,{axis:0|1;at:number;lo:number;hi:number}[]>();for(const s of segments.values()){const key=`${s.axis}:${s.at.toFixed(6)}`;grouped.set(key,[...(grouped.get(key)??[]),s]);}
  const walls:Wall[]=[];
  for(const list of grouped.values()) {
    list.sort((a,b)=>a.lo-b.lo);const merged:typeof list=[];
    for(const s of list){const last=merged.at(-1);if(last&&s.lo<=last.hi+1e-7)last.hi=Math.max(last.hi,s.hi);else merged.push({...s});}
    for(const s of merged)walls.push({id:`grid-wall-${walls.length}`,geometry:{type:'polyline',points:s.axis===0?[[s.at,s.lo],[s.at,s.hi]]:[[s.lo,s.at],[s.hi,s.at]]},thickness,height:base.floor.height,fixed:false,role:'partition',generatedBy:'layout-grid-v1'});
  }
  let wallGeometry:Geometry=[];for(const w of walls)wallGeometry=wallGeometry.length?(union(wallGeometry,[footprint(w,w.geometry.points[0],w.geometry.points[1])])??[]):[footprint(w,w.geometry.points[0],w.geometry.points[1])];
  const model=structuredClone(base);model.model.revisionId=revisionId;model.model.parentRevisionId=base.model.revisionId;model.walls.push(...walls);model.spaceTypes=[];model.spaces=[];
  for(const [i,r] of regions.entries()) {
    const ps=polygons(wallGeometry.length?diff([r.boundary],wallGeometry):[r.boundary]);if(ps.length!==1||ps[0].length!==1)return;
    const name=brief.rooms.find(room=>room.id===r.id)?.name??'交通空间';
    model.spaceTypes.push({id:`grid-type-${i}`,label:name,color:['#A8C8F0','#98D4B8','#FFE4A8','#C8B8E8','#FFB878','#88C8E8'][i%6]});
    model.spaces.push({id:r.id,allocationId:r.id,boundary:cleanRing(ps[0][0]),typeId:`grid-type-${i}`,usage:name,enclosed:true,targetArea:brief.rooms.find(room=>room.id===r.id)?.area.target??polygonArea(cleanRing(ps[0][0]))/(base.model.units==='mm'?1e6:1),performancePreferences:{}});
  }
  return model;
}
