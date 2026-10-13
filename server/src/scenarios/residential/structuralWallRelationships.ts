import { pointInOrOnPolygon, type ResidentialBrief, type SpaceModel, type StructuralWallRelationships, type StructuralWallInterval, type Vec2, type Wall } from '@sdd/shared';

/** Wall-face ownership, split at exact polygon crossings rather than a sampling phase. */
export function assessStructuralWallRelationships(model: SpaceModel, brief: ResidentialBrief): StructuralWallRelationships {
  const scale = model.model.units === 'mm' ? 1000 : 1;
  const epsilon = 1e-5 * scale;
  const result: StructuralWallRelationships = {walls: [], unexplainedLength: 0, warnings: [], penalty: 0};
  const purpose = new Map((brief.structuralWallUses ?? []).map(u => [u.wallId, u.purpose]));
  const footprints = model.walls.flatMap(w => w.geometry.points.slice(1).map((b, i) => ({id:w.id, ring:wallFaceRing(w, w.geometry.points[i], b)})));
  for (const wall of model.walls.filter(w => w.fixed && w.role === 'structural')) {
    const intervals: StructuralWallInterval[] = [];
    for (let k = 1; k < wall.geometry.points.length; k++) {
      const a = wall.geometry.points[k-1], b = wall.geometry.points[k];
      const length = Math.hypot(b[0]-a[0], b[1]-a[1]);
      if (length < epsilon) continue;
      const ux = (b[0]-a[0])/length, uy = (b[1]-a[1])/length;
      const offset = wall.thickness/2 + epsilon;
      const facePoint = (t:number, sign:number):Vec2 => [a[0]+t*ux-sign*uy*offset, a[1]+t*uy+sign*ux*offset];
      const cuts = [0, length];
      for (const sign of [-1, 1]) {
        const origin = facePoint(0, sign);
        for (const ring of [model.floor.boundary, ...model.spaces.map(s=>s.boundary), ...footprints.filter(f=>f.id!==wall.id).map(f=>f.ring)]) {
          for (let i=1; i<ring.length; i++) {
            const c=ring[i-1], d=ring[i];
            const v0=ux*(c[1]-origin[1])-uy*(c[0]-origin[0]);
            const v1=ux*(d[1]-origin[1])-uy*(d[0]-origin[0]);
            if (Math.abs(v0-v1)<1e-12) continue;
            const f=v0/(v0-v1);
            if (f < 0 || f > 1) continue;
            const t=(c[0]+f*(d[0]-c[0])-origin[0])*ux+(c[1]+f*(d[1]-c[1])-origin[1])*uy;
            if (t>epsilon && t<length-epsilon) cuts.push(t);
          }
        }
      }
      cuts.sort((x,y)=>x-y);
      for (let i=1; i<cuts.length; i++) {
        const lo=cuts[i-1], hi=cuts[i];
        if (hi-lo<epsilon) continue;
        const left=facePoint((lo+hi)/2, 1), right=facePoint((lo+hi)/2, -1);
        // Exterior walls have one outside face; they are not unexplained interior walls.
        if (![left,right].every(p=>pointInOrOnPolygon(p,model.floor.boundary,epsilon/10))) continue;
        const leftSpaceId=model.spaces.find(s=>pointInOrOnPolygon(left,s.boundary,epsilon/10))?.id;
        const rightSpaceId=model.spaces.find(s=>pointInOrOnPolygon(right,s.boundary,epsilon/10))?.id;
        const occupied=[left,right].some(p=>footprints.some(f=>f.id!==wall.id&&pointInOrOnPolygon(p,f.ring,epsilon/10)));
        const status:StructuralWallInterval['status']=occupied?'junction':!leftSpaceId||!rightSpaceId?'unassigned':leftSpaceId!==rightSpaceId?'separator':purpose.has(wall.id)?'intentional':'same_space';
        const segment:[Vec2,Vec2]=[[a[0]+lo*ux,a[1]+lo*uy],[a[0]+hi*ux,a[1]+hi*uy]];
        const last=intervals.at(-1);
        if (last && last.status===status && last.leftSpaceId===leftSpaceId && last.rightSpaceId===rightSpaceId && Math.hypot(last.segment[1][0]-segment[0][0],last.segment[1][1]-segment[0][1])<epsilon) {
          last.segment[1]=segment[1]; last.length+=(hi-lo)/scale;
        } else intervals.push({segment,length:(hi-lo)/scale,leftSpaceId,rightSpaceId,status});
      }
    }
    if (!intervals.length) continue;
    const sum=(statuses:StructuralWallInterval['status'][])=>intervals.filter(i=>statuses.includes(i.status)).reduce((n,i)=>n+i.length,0);
    const review={wallId:wall.id,length:sum(['separator','same_space','intentional','junction','unassigned']),separatorLength:sum(['separator']),sameSpaceLength:sum(['same_space','intentional']),unexplainedLength:sum(['same_space','unassigned']),purpose:purpose.get(wall.id),intervals};
    result.walls.push(review); result.unexplainedLength+=review.unexplainedLength;
    for (const interval of intervals) {
      if (interval.status==='same_space' && interval.length>.05) {
        const name=model.spaces.find(s=>s.id===interval.leftSpaceId)?.usage??interval.leftSpaceId;
        result.warnings.push(`承重墙 ${wall.id} 有${interval.length.toFixed(2)}m墙段两侧同属${name}，空间绕墙端连接，未说明突出墙段用途`);
      }
      if (interval.status==='unassigned' && interval.length>.05) result.warnings.push(`承重墙 ${wall.id} 有${interval.length.toFixed(2)}m墙段缺少两侧空间归属`);
    }
  }
  // This is a design preference, not a blanket ban on intentional open-space wall piers.
  result.penalty=result.unexplainedLength*2;
  return result;
}

function wallFaceRing(wall:Wall,a:Vec2,b:Vec2):Vec2[] {
  const l=Math.hypot(b[0]-a[0],b[1]-a[1])||1;
  const nx=-(b[1]-a[1])/l*wall.thickness/2,ny=(b[0]-a[0])/l*wall.thickness/2;
  return [[a[0]+nx,a[1]+ny],[b[0]+nx,b[1]+ny],[b[0]-nx,b[1]-ny],[a[0]-nx,a[1]-ny],[a[0]+nx,a[1]+ny]];
}
