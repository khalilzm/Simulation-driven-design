import { diff, union, type Geometry } from 'martinez-polygon-clipping';
import type { SpaceModel, Vec2, Wall } from '@sdd/shared';
import { pointAlongWallPolyline } from './polygon';
import { outsideArea, intersection, geometryArea } from './regions';

export function doorApron(model:SpaceModel,wall:Wall,position:number,width:number,depthMetres:number):{roomId:string;side:'left'|'right';boundary:Vec2[]}[] {
  const scale=model.model.units==='mm'?1000:1;
  const a=pointAlongWallPolyline(wall.geometry.points,position-width/2),b=pointAlongWallPolyline(wall.geometry.points,position+width/2);
  if(!a||!b)return [];
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!length)return [];
  const nx=-(b[1]-a[1])/length,ny=(b[0]-a[0])/length,offset=wall.thickness/2+.0001*scale,depth=depthMetres*scale;
  const result:{roomId:string;side:'left'|'right';boundary:Vec2[]}[]=[];
  for(const sign of [-1,1]) {
    const p:Vec2=[a[0]+sign*nx*offset,a[1]+sign*ny*offset],q:Vec2=[b[0]+sign*nx*offset,b[1]+sign*ny*offset];
    const end:Vec2=[q[0]+sign*nx*depth,q[1]+sign*ny*depth],start:Vec2=[p[0]+sign*nx*depth,p[1]+sign*ny*depth];
    const boundary=[p,q,end,start,p];
    const room=model.spaces.find(s=>outsideArea(boundary,s.boundary)/scale**2<1e-7);
    if(room)result.push({roomId:room.id,side:sign===1?'left':'right',boundary});
  }
  return result;
}
export function swingFootprint(model:SpaceModel,wall:Wall,position:number,width:number,side:'left'|'right',hinge:'start'|'end'='start'):Vec2[] {
  const a=pointAlongWallPolyline(wall.geometry.points,position-width/2)!,b=pointAlongWallPolyline(wall.geometry.points,position+width/2)!;
  const origin=hinge==='start'?a:b,tip=hinge==='start'?b:a,dx=tip[0]-origin[0],dy=tip[1]-origin[1];
  const sign=(side==='left'?1:-1)*(hinge==='start'?1:-1),ring:Vec2[]=[origin];
  for(let i=0;i<=12;i++){const angle=sign*Math.PI/2*i/12;ring.push([origin[0]+dx*Math.cos(angle)-dy*Math.sin(angle),origin[1]+dx*Math.sin(angle)+dy*Math.cos(angle)]);}
  ring.push(origin);return ring;
}
export const swingCollision=(a:Vec2[],b:Vec2[],scale=1)=>geometryArea(intersection([a],[b]))/scale**2>1e-4;

/** A swing may intersect its host wall reveal, but no other fixed wall or room. */
export function doorSwingFits(model:SpaceModel,wall:Wall,swing:Vec2[],roomId:string):boolean {
  const room=model.spaces.find(s=>s.id===roomId);if(!room)return false;
  let allowed:Geometry=[room.boundary];
  for(let i=1;i<wall.geometry.points.length;i++) {
    const a=wall.geometry.points[i-1],b=wall.geometry.points[i],l=Math.hypot(b[0]-a[0],b[1]-a[1]);if(!l)continue;
    const nx=-(b[1]-a[1])/l*wall.thickness/2,ny=(b[0]-a[0])/l*wall.thickness/2;
    const strip:Vec2[]=[[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny],[a[0]+nx,a[1]+ny]];
    allowed=union(allowed,[strip])??allowed;
  }
  const scale=model.model.units==='mm'?1000:1;
  return geometryArea(diff([swing],allowed))/scale**2<1e-6;
}
