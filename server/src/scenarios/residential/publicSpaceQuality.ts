import { permitsThrough, pointInOrOnPolygon, type PublicSpaceReview, type ResidentialBrief, type SpaceModel, type Vec2 } from '@sdd/shared';
import { polygonArea } from '../../geometry/polygon';
import { geometryArea, intersection, rectangle } from '../../geometry/regions';

/** Largest contained rectangle on the exact orthogonal boundary grid, in model units. */
export function largestRoomRectangle(boundary:Vec2[]): {boundary:Vec2[];area:number} {
  const xs=[...new Set(boundary.map(p=>p[0]))].sort((a,b)=>a-b);
  const ys=[...new Set(boundary.map(p=>p[1]))].sort((a,b)=>a-b);
  const nx=xs.length-1, heights=new Float64Array(nx);
  const orthogonal=boundary.slice(1).every((p,i)=>Math.abs(p[0]-boundary[i][0])<1e-8||Math.abs(p[1]-boundary[i][1])<1e-8);
  let best={boundary:[] as Vec2[],area:0};
  for(let y=0;y+1<ys.length;y++) {
    for(let x=0;x<nx;x++) {
      const inside=orthogonal?pointInOrOnPolygon([(xs[x]+xs[x+1])/2,(ys[y]+ys[y+1])/2],boundary,1e-8)
        :Math.abs(geometryArea(intersection([boundary],[rectangle(xs[x],ys[y],xs[x+1],ys[y+1])]))-(xs[x+1]-xs[x])*(ys[y+1]-ys[y]))<1e-8;
      heights[x]=inside?heights[x]+ys[y+1]-ys[y]:0;
    }
    for(let x0=0;x0<nx;x0++) {
      let h=Infinity;
      for(let x1=x0;x1<nx;x1++) {
        h=Math.min(h,heights[x1]);if(h<=1e-9)break;
        const area=h*(xs[x1+1]-xs[x0]);
        if(area>best.area+1e-9)best={area,boundary:rectangle(xs[x0],ys[y+1]-h,xs[x1+1],ys[y+1])};
      }
    }
  }
  return best;
}

export function assessPublicSpaceQuality(model:SpaceModel,brief:ResidentialBrief):PublicSpaceReview[] {
  const scale=model.model.units==='mm'?1000:1;
  return model.spaces.flatMap(s=>{
    const req=brief.rooms.find(r=>r.id===s.id);
    if(!req||!permitsThrough(req)||req.kind!=='living')return [];
    const core=largestRoomRectangle(s.boundary),area=polygonArea(s.boundary)/scale**2,coreArea=core.area/scale**2;
    const coreRatio=area?coreArea/area:0;
    return [{spaceId:s.id,name:s.usage,area,coreArea,coreBoundary:core.boundary,coreRatio,fragmentationArea:Math.max(0,area-coreArea),penalty:(1-coreRatio)*4}];
  });
}
