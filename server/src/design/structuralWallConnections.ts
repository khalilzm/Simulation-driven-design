import type { SpaceModel, StructuralConnectionReview, Vec2, Wall } from '@sdd/shared';

const sub=(a:Vec2,b:Vec2):Vec2=>[a[0]-b[0],a[1]-b[1]];
const dot=(a:Vec2,b:Vec2)=>a[0]*b[0]+a[1]*b[1];
const cross=(a:Vec2,b:Vec2)=>a[0]*b[1]-a[1]*b[0];
const unit=(v:Vec2):Vec2=>{const l=Math.hypot(...v)||1;return [v[0]/l,v[1]/l];};
interface Continuation {host:Wall;point:Vec2;axisOffset:number;end:0|1}

function continuations(wall:Wall,fixed:Wall[],tolerance:number):Continuation[] {
  const points=wall.geometry.points,result:Continuation[]=[];
  for(const end of [0,1] as const) {
    const p=end===0?points[0]:points.at(-1)!;
    const toward=end===0?points[1]:points.at(-2)!;
    const out=unit(sub(p,toward));
    for(const host of fixed) {
      const ps=host.geometry.points;
      for(const [point,into] of [[ps[0],ps[1]],[ps.at(-1)!,ps.at(-2)!]] as [Vec2,Vec2][]) {
        if(dot(out,unit(sub(into,point)))<1-1e-7)continue;
        const delta=sub(point,p),axisOffset=Math.abs(cross(out,delta));
        if(Math.abs(dot(delta,out))>tolerance||axisOffset>(host.thickness+wall.thickness)/2+tolerance)continue;
        result.push({host,point,axisOffset,end});
      }
    }
  }
  return result;
}

/** Mutates only fresh generated partitions, before openings exist. Fixed inputs are read-only. */
export function connectPartitionsToStructure(partitions:Wall[],fixed:Wall[],scale=1):void {
  const tolerance=.002*scale;
  const oldNodes=new Map<string,Vec2>();
  const key=(p:Vec2)=>`${Math.round(p[0]/tolerance)}:${Math.round(p[1]/tolerance)}`;
  for(const wall of partitions) {
    if(wall.fixed)continue;
    const hits=continuations(wall,fixed,tolerance).sort((a,b)=>a.axisOffset-b.axisOffset);
    if(!hits.length)continue;
    const hit=hits[0],ps=wall.geometry.points,endpoint=hit.end===0?ps[0]:ps.at(-1)!;
    const shift=sub(hit.point,endpoint),old=ps.map(p=>[...p] as Vec2);
    wall.geometry.points=ps.map(p=>[Number((p[0]+shift[0]).toFixed(9)),Number((p[1]+shift[1]).toFixed(9))]);
    wall.thickness=hit.host.thickness;
    for(const index of [0,ps.length-1])oldNodes.set(key(old[index]),wall.geometry.points[index]);
  }
  for(const wall of partitions.filter(w=>!w.fixed))for(const index of [0,wall.geometry.points.length-1]) {
    const moved=oldNodes.get(key(wall.geometry.points[index]));
    if(moved)wall.geometry.points[index]=[...moved];
  }
  // Perpendicular walls meet the host axis; wall-face trims handle their physical join.
  for(const wall of partitions.filter(w=>!w.fixed))for(const index of [0,wall.geometry.points.length-1]) {
    const p=wall.geometry.points[index],toward=wall.geometry.points[index===0?1:index-1],out=unit(sub(p,toward));
    let best:{point:Vec2;distance:number}|undefined;
    for(const host of fixed)for(let i=1;i<host.geometry.points.length;i++) {
      const a=host.geometry.points[i-1],b=host.geometry.points[i],direction=unit(sub(b,a)),length=Math.hypot(...sub(b,a));
      if(Math.abs(dot(out,direction))>1e-7)continue;
      const projection=dot(sub(p,a),direction);
      if(projection<-tolerance||projection>length+tolerance)continue;
      const point:Vec2=[a[0]+projection*direction[0],a[1]+projection*direction[1]],along=dot(sub(point,p),out);
      if(along<-tolerance||along>host.thickness/2+tolerance)continue;
      if(!best||along<best.distance)best={point,distance:along};
    }
    if(best)wall.geometry.points[index]=best.point;
  }
}

export function assessStructuralConnections(model:SpaceModel):StructuralConnectionReview {
  const scale=model.model.units==='mm'?1000:1,tolerance=.002*scale;
  const fixed=model.walls.filter(w=>w.fixed&&w.role==='structural');
  const result:StructuralConnectionReview={connections:[],mismatchCount:0,warnings:[]};
  for(const wall of model.walls.filter(w=>!w.fixed&&w.generatedBy)) {
    for(const hit of continuations(wall,fixed,tolerance)) {
      const thicknessDifference=Math.abs(wall.thickness-hit.host.thickness)/scale;
      const aligned=hit.axisOffset<=tolerance&&thicknessDifference<=.002;
      result.connections.push({structuralWallId:hit.host.id,partitionWallId:wall.id,kind:'continuation',point:hit.point,axisOffset:hit.axisOffset/scale,thicknessDifference,structuralThickness:hit.host.thickness/scale,partitionThickness:wall.thickness/scale,aligned});
      if(!aligned){result.mismatchCount++;result.warnings.push(`隔墙 ${wall.id} 续接承重墙 ${hit.host.id} 中心线偏移${(hit.axisOffset/scale*1000).toFixed(0)}mm，厚度${(wall.thickness/scale*1000).toFixed(0)}/${(hit.host.thickness/scale*1000).toFixed(0)}mm`);}
    }
    for(const index of [0,wall.geometry.points.length-1]) {
      const p=wall.geometry.points[index],toward=wall.geometry.points[index===0?1:index-1],out=unit(sub(p,toward));
      for(const host of fixed)for(let i=1;i<host.geometry.points.length;i++) {
        const a=host.geometry.points[i-1],b=host.geometry.points[i],direction=unit(sub(b,a)),length=Math.hypot(...sub(b,a));
        if(Math.abs(dot(out,direction))>1e-7)continue;
        const projection=dot(sub(p,a),direction);
        if(projection<-tolerance||projection>length+tolerance)continue;
        const point:Vec2=[a[0]+projection*direction[0],a[1]+projection*direction[1]],along=dot(sub(point,p),out);
        if(along<-tolerance||along>host.thickness/2+tolerance)continue;
        if(result.connections.some(c=>c.partitionWallId===wall.id&&c.structuralWallId===host.id&&Math.hypot(...sub(c.point,point))<tolerance))continue;
        result.connections.push({structuralWallId:host.id,partitionWallId:wall.id,kind:projection>tolerance&&projection<length-tolerance?'tee':'corner',point,axisOffset:0,thicknessDifference:Math.abs(wall.thickness-host.thickness)/scale,structuralThickness:host.thickness/scale,partitionThickness:wall.thickness/scale,aligned:true});
      }
    }
  }
  return result;
}
