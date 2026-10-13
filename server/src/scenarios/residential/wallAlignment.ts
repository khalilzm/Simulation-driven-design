import { layoutSettings, pointInOrOnPolygon, type ResidentialBrief, type SpaceModel, type Vec2, type Wall, type WallAlignmentReview } from '@sdd/shared';

interface Bounds {minX:number;maxX:number;minY:number;maxY:number}

/** Preliminary alignment cost for adjacent room allocations, before wall thickness is applied. */
export function rectangleAlignmentOffset(a:Bounds,b:Bounds,maxOffset:number,tolerance=1e-7):number {
  const short=(d:number)=>d>tolerance&&d<maxOffset-tolerance?d:0;
  if ((Math.abs(a.maxY-b.minY)<tolerance||Math.abs(b.maxY-a.minY)<tolerance)
    && Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)>tolerance) {
    return short(Math.abs(a.minX-b.minX))+short(Math.abs(a.maxX-b.maxX));
  }
  if ((Math.abs(a.maxX-b.minX)<tolerance||Math.abs(b.maxX-a.minX)<tolerance)
    && Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY)>tolerance) {
    return short(Math.abs(a.minY-b.minY))+short(Math.abs(a.maxY-b.maxY));
  }
  return 0;
}

interface Segment {wall:Wall;axis:0|1;at:number;lo:number;hi:number}

/** Detect short doglegs connecting continuing partition walls on the same side of a space. */
export function assessWallAlignment(model:SpaceModel,brief:ResidentialBrief):WallAlignmentReview {
  const scale=model.model.units==='mm'?1000:1,tolerance=.002*scale;
  const maxOffset=layoutSettings(brief).passageWidth*scale;
  const segments:Segment[]=model.walls.filter(w=>!w.fixed&&w.generatedBy).flatMap(w=>w.geometry.points.slice(1).flatMap((b,i)=>{
    const a=w.geometry.points[i],axis=Math.abs(a[0]-b[0])<1e-7?0:Math.abs(a[1]-b[1])<1e-7?1:undefined;
    return axis===undefined?[]:[{wall:w,axis,at:a[axis],lo:Math.min(a[1-axis],b[1-axis]),hi:Math.max(a[1-axis],b[1-axis])}];
  }));
  const result:WallAlignmentReview={steps:[],totalOffset:0,warnings:[],penalty:0};
  const seen=new Set<string>();
  for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
    const a=segments[i],b=segments[j];
    if(a.axis!==b.axis||a.wall.id===b.wall.id)continue;
    const lower=Math.abs(a.hi-b.lo)<tolerance?a:Math.abs(b.hi-a.lo)<tolerance?b:undefined;
    if(!lower)continue;
    const upper=lower===a?b:a,join=(lower.hi+upper.lo)/2;
    if(Math.min(lower.hi-lower.lo,upper.hi-upper.lo)<=Math.max(a.wall.thickness,b.wall.thickness))continue;
    const connector=segments.find(s=>s.axis!==a.axis&&Math.abs(s.at-join)<tolerance&&s.lo<=Math.min(a.at,b.at)+tolerance&&s.hi>=Math.max(a.at,b.at)-tolerance);
    if(!connector)continue;
    for(const sign of [-1,1]) {
      const side=(s:Segment):Vec2=>{
        const across=s.at+sign*(s.wall.thickness/2+1e-5*scale);
        const along=s===lower?join-Math.min(.2*scale,(s.hi-s.lo)/2):join+Math.min(.2*scale,(s.hi-s.lo)/2);
        return s.axis===0?[across,along]:[along,across];
      };
      const owner=model.spaces.find(s=>pointInOrOnPolygon(side(lower),s.boundary,1e-8)&&pointInOrOnPolygon(side(upper),s.boundary,1e-8));
      if(!owner)continue;
      // Compare actual faces. Different wall thicknesses may have aligned faces with offset axes.
      const offset=Math.abs(lower.at+sign*lower.wall.thickness/2-upper.at-sign*upper.wall.thickness/2);
      if(offset<=tolerance||offset>=maxOffset-tolerance)continue;
      const key=[a.wall.id,b.wall.id].sort().join('|')+`:${join}:${owner.id}`;
      if(seen.has(key))continue;seen.add(key);
      const segment:[Vec2,Vec2]=a.axis===0?[[lower.at,join],[upper.at,join]]:[[join,lower.at],[join,upper.at]];
      result.steps.push({wallIds:[lower.wall.id,upper.wall.id],connectorWallId:connector.wall.id,spaceId:owner.id,offset:offset/scale,segment});
      result.totalOffset+=offset/scale;
      result.warnings.push(`${owner.usage}相邻隔墙 ${lower.wall.id}/${upper.wall.id} 错位${(offset/scale).toFixed(2)}m，形成短台阶，建议连续对齐`);
    }
  }
  result.penalty=result.totalOffset*2+result.steps.length*.1;
  return result;
}
