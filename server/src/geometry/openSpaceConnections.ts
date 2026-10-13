import { pointInOrOnPolygon, resolveWallJunctions, type SpaceModel, type Vec2 } from '@sdd/shared';
import { sharedSegments } from './regions';

export interface OpenSpaceConnection {from:string;to:string;netWidthM:number;segments:[Vec2,Vec2][]}
const cross=(a:Vec2,b:Vec2)=>a[0]*b[1]-a[1]*b[0];

/** Real wall-free shared boundaries; neither enclosed flags nor touching corners create a route. */
export function openSpaceConnections(model:SpaceModel):OpenSpaceConnection[] {
  const scale=model.model.units==='mm'?1000:1,epsilon=1e-7*scale;
  const junctions=resolveWallJunctions(model.walls);
  const walls=[...junctions.values()];
  const result:OpenSpaceConnection[]=[];
  for(let i=0;i<model.spaces.length;i++)for(let j=i+1;j<model.spaces.length;j++) {
    const a=model.spaces[i],b=model.spaces[j];
    if(a.enclosed!==false&&b.enclosed!==false)continue;
    const free:[Vec2,Vec2][]=[];
    for(const [start,end] of sharedSegments(a.boundary,b.boundary)) {
      const direction:Vec2=[end[0]-start[0],end[1]-start[1]],length=Math.hypot(...direction);
      if(length<=epsilon)continue;
      const at=(t:number):Vec2=>[start[0]+direction[0]*t,start[1]+direction[1]*t];
      const cuts=new Set([0,1]);
      for(const polygon of walls)for(let k=0;k<polygon.length;k++) {
        const p=polygon[k],q=polygon[(k+1)%polygon.length],edge:Vec2=[q[0]-p[0],q[1]-p[1]],offset:Vec2=[p[0]-start[0],p[1]-start[1]];
        const denominator=cross(direction,edge);
        if(Math.abs(denominator)>1e-12*length*Math.max(Math.hypot(...edge),1)) {
          const t=cross(offset,edge)/denominator,u=cross(offset,direction)/denominator;
          if(t>=0&&t<=1&&u>=0&&u<=1)cuts.add(t);
        }else if(Math.abs(cross(direction,offset))<=epsilon*length) {
          for(const point of [p,q]){const t=((point[0]-start[0])*direction[0]+(point[1]-start[1])*direction[1])/length**2;if(t>0&&t<1)cuts.add(t);}
        }
      }
      const sorted=[...cuts].sort((x,y)=>x-y);
      for(let k=1;k<sorted.length;k++) {
        const lo=sorted[k-1],hi=sorted[k];
        if((hi-lo)*length<=epsilon||walls.some(polygon=>pointInOrOnPolygon(at((lo+hi)/2),polygon,epsilon)))continue;
        const last=free.at(-1);
        if(last&&Math.hypot(last[1][0]-at(lo)[0],last[1][1]-at(lo)[1])<=epsilon&&Math.abs(cross([last[1][0]-last[0][0],last[1][1]-last[0][1]],direction))<=epsilon*length)last[1]=at(hi);
        else free.push([at(lo),at(hi)]);
      }
    }
    if(free.length)result.push({from:a.id,to:b.id,segments:free,netWidthM:Math.max(...free.map(([p,q])=>Math.hypot(q[0]-p[0],q[1]-p[1])))/scale});
  }
  return result;
}
