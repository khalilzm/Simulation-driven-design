import { pointInOrOnPolygon, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { pointAlongWallPolyline } from './polygon';
import { segmentCoveredBy } from './segments';
import { sharedSegments } from './regions';

/** Imported DXF envelopes follow the outer wall face, while openings follow its centerline. */
export function openingFacesOutside(wall: Wall, a: Vec2, b: Vec2, boundary: Vec2[]): boolean {
  if (segmentCoveredBy(a,b,sharedSegments(boundary,[a,b]))) return true;
  if (!wall.analysisProperties?.dxfSourceId) return false;
  const length=Math.hypot(b[0]-a[0],b[1]-a[1]);
  if (length<1e-9) return false;
  const nx=-(b[1]-a[1])/length*wall.thickness/2, ny=(b[0]-a[0])/length*wall.thickness/2;
  return [-1,1].some((side) => {
    const x: Vec2=[a[0]+nx*side,a[1]+ny*side],y: Vec2=[b[0]+nx*side,b[1]+ny*side];
    return segmentCoveredBy(x,y,sharedSegments(boundary,[x,y]));
  });
}

/** Room boundaries describe usable wall-face polygons. Legacy models use centerline polygons. */
export function openingRoomSides(model: SpaceModel, wall: Wall, position: number, width: number): string[] {
  const center = pointAlongWallPolyline(wall.geometry.points, position);
  const a = pointAlongWallPolyline(wall.geometry.points, position-width/2);
  const b = pointAlongWallPolyline(wall.geometry.points, position+width/2);
  if (!center || !a || !b) return [];
  const length = Math.hypot(b[0]-a[0],b[1]-a[1]);
  if (!length) return [];
  const offset = wall.thickness/2 + (model.model.units === 'mm' ? 0.01 : 0.00001);
  const normal: Vec2 = [-(b[1]-a[1])/length*offset,(b[0]-a[0])/length*offset];
  const found = new Set<string>();
  for (const sign of [-1,1]) {
    const probes = [0.001,0.5,0.999].map(t => [a[0]+t*(b[0]-a[0])+sign*normal[0],a[1]+t*(b[1]-a[1])+sign*normal[1]] as Vec2);
    const rooms = model.spaces.filter(s => probes.every(p => pointInOrOnPolygon(p,s.boundary,1e-8)));
    if (rooms.length === 1) found.add(rooms[0].id);
  }
  if (openingFacesOutside(wall,a,b,model.floor.boundary)) found.add('outside');
  return [...found];
}
