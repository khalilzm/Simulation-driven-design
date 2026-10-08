import { diff, union, type Geometry } from 'martinez-polygon-clipping';
import { pointInOrOnPolygon, type RoomKind, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { boundsOf, pointAlongWallPolyline, polygonArea } from '../model/geometry';
import { outsideArea, intersection, geometryArea } from './regionGeometry';

/** Product design thresholds in metres, not a building-code compliance claim. */
export const RESIDENTIAL_QUALITY = { routeWidth: .9, gridStep: .12, doorDepth: .9, tailArea: .25, tailRatio: .025,
  body: {bedroom:[2.4,2.7],living:[3,3],kitchen:[1.8,2],bathroom:[1.5,1.5],study:[1.8,2],circulation:[.9,.9],other:[1.5,1.5]} as Record<RoomKind,[number,number]> };
export interface RoomQuality {errors:string[];area:number;usableArea:number;tailArea:number;coreComponents:number;penalty:number;routeWidth:number;gridStep:number}
const distance=(p:Vec2,a:Vec2,b:Vec2)=> {
  const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
  return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
};
export function assessRoomQuality(boundary:Vec2[],kind:RoomKind,scale=1, options?:{routeWidth:number;body?:[number,number]}):RoomQuality {
  const ring=boundary.map(p=>[p[0]/scale,p[1]/scale] as Vec2),b=boundsOf(ring)!;
  const odd=(n:number)=>n%2?n:n+1;
  const nx=odd(Math.ceil((b.maxX-b.minX)/RESIDENTIAL_QUALITY.gridStep)),ny=odd(Math.ceil((b.maxY-b.minY)/RESIDENTIAL_QUALITY.gridStep));
  if(nx*ny>100000||nx<1||ny<1) return {errors:['房间超出质量检查网格范围'],area:polygonArea(ring),usableArea:0,tailArea:0,coreComponents:0,penalty:0,routeWidth:.9,gridStep:.12};
  const dx=(b.maxX-b.minX)/nx,dy=(b.maxY-b.minY)/ny,radius=(options?.routeWidth??RESIDENTIAL_QUALITY.routeWidth)/2;
  const cells=new Uint8Array(nx*ny),core=new Uint8Array(nx*ny),full=new Uint8Array(nx*ny);
  const point=(x:number,y:number):Vec2=>[b.minX+(x+.5)*dx,b.minY+(y+.5)*dy];
  let interior=0;
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++) {
    const p=point(x,y),i=y*nx+x;
    if(!pointInOrOnPolygon(p,ring,1e-8))continue;
    cells[i]=1;interior++;
    let clearance=Infinity;
    for(let k=0;k+1<ring.length;k++)clearance=Math.min(clearance,distance(p,ring[k],ring[k+1]));
    if(clearance>=radius-1e-8)core[i]=1;
    full[i]=[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]].every(([ox,oy])=>pointInOrOnPolygon([p[0]+ox*dx,p[1]+oy*dy],ring,1e-8))?1:0;
  }
  const visited=new Uint8Array(cells.length),components:number[][]=[];
  for(let i=0;i<core.length;i++)if(core[i]&&!visited[i]) {
    const queue=[i];visited[i]=1;
    for(let at=0;at<queue.length;at++) {
      const index=queue[at],x=index%nx,y=Math.floor(index/nx);
      for(const [xx,yy]of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(xx>=0&&xx<nx&&yy>=0&&yy<ny) {
        const next=yy*nx+xx;if(core[next]&&!visited[next]){visited[next]=1;queue.push(next);}
      }
    }
    components.push(queue);
  }
  components.sort((a,b)=>b.length-a.length);
  const major=components.filter(c=>c.length*dx*dy>=.08),errors:string[]=[];
  if(!components.length)errors.push(`缺少满足${(radius*2).toFixed(2)}m净宽的可通行主体`);
  if(major.length>1)errors.push(`房间主体被小于${(radius*2).toFixed(2)}m的窄颈分隔`);
  // Chebyshev dilation avoids treating ordinary rectangular corners as wasted area.
  const covered=new Uint8Array(cells.length),reachX=Math.ceil((radius+dx)/dx),reachY=Math.ceil((radius+dy)/dy);
  for(const index of components[0]??[]) {
    const x=index%nx,y=Math.floor(index/nx);
    for(let yy=Math.max(0,y-reachY);yy<=Math.min(ny-1,y+reachY);yy++)for(let xx=Math.max(0,x-reachX);xx<=Math.min(nx-1,x+reachX);xx++)covered[yy*nx+xx]=1;
  }
  let tail=0;for(let i=0;i<cells.length;i++)if(cells[i]&&!covered[i])tail+=dx*dy;
  const area=polygonArea(ring);
  if(tail>Math.max(RESIDENTIAL_QUALITY.tailArea,area*RESIDENTIAL_QUALITY.tailRatio))errors.push(`狭长或不可通行尾部约${tail.toFixed(2)}㎡，不能作为有效房间面积`);
  // An axis-aligned furniture/body rectangle, checked in both orientations.
  const prefix=new Int32Array((nx+1)*(ny+1));
  for(let y=1;y<=ny;y++)for(let x=1;x<=nx;x++)prefix[y*(nx+1)+x]=full[(y-1)*nx+x-1]+prefix[(y-1)*(nx+1)+x]+prefix[y*(nx+1)+x-1]-prefix[(y-1)*(nx+1)+x-1];
  const fits=(width:number,height:number)=> {
    const w=Math.ceil((width-1e-8)/dx),h=Math.ceil((height-1e-8)/dy);
    for(let y=0;y+h<=ny;y++)for(let x=0;x+w<=nx;x++)if(prefix[(y+h)*(nx+1)+x+w]-prefix[y*(nx+1)+x+w]-prefix[(y+h)*(nx+1)+x]+prefix[y*(nx+1)+x]===w*h)return true;
    return false;
  };
  const body=options?options.body:RESIDENTIAL_QUALITY.body[kind];
  if(body){const [w,h]=body;if(!fits(w,h)&&!fits(h,w))errors.push(`无法容纳${w.toFixed(1)}×${h.toFixed(1)}m房间主体`);}
  return {errors,area,usableArea:Math.max(0,area-tail),tailArea:tail,coreComponents:major.length,penalty:tail/Math.max(area,1)*3+(major.length>1?1:0),routeWidth:radius*2,gridStep:.12};
}

export function doorApron(model:SpaceModel,wall:Wall,position:number,width:number,depthMetres=RESIDENTIAL_QUALITY.doorDepth):{roomId:string;side:'left'|'right';boundary:Vec2[]}[] {
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

/** Prevent parallel new walls from creating unassigned-purpose structural slivers. */
export function structuralGapErrors(walls:Wall[],fixed:Wall[],scale=1):string[] {
  const errors:string[]=[];
  for(const wall of walls)for(const host of fixed)for(let k=0;k+1<host.geometry.points.length;k++) {
    const [a,b]=wall.geometry.points,[c,d]=[host.geometry.points[k],host.geometry.points[k+1]];
    const length=Math.hypot(b[0]-a[0],b[1]-a[1]),other=Math.hypot(d[0]-c[0],d[1]-c[1]);if(!length||!other)continue;
    const ux=(b[0]-a[0])/length,uy=(b[1]-a[1])/length;
    if(Math.abs(ux*(d[1]-c[1])-uy*(d[0]-c[0]))/other>1e-6)continue;
    const distance=Math.abs(ux*(c[1]-a[1])-uy*(c[0]-a[0]));
    const gap=(distance-(wall.thickness+host.thickness)/2)/scale;
    const t=(p:Vec2)=>(p[0]-a[0])*ux+(p[1]-a[1])*uy;
    const overlap=Math.min(length,Math.max(t(c),t(d)))-Math.max(0,Math.min(t(c),t(d)));
    if(gap>.001&&gap<RESIDENTIAL_QUALITY.routeWidth-.001&&overlap/scale>=1)errors.push(`新增墙 ${wall.id} 与承重墙 ${host.id} 形成${gap.toFixed(2)}m夹缝（连续${(overlap/scale).toFixed(2)}m）`);
  }
  return [...new Set(errors)];
}

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
