import type { PedestrianResult } from '@sdd/shared';
import type { PolygonFill } from './modelRender';
import { densityToColor, resolveDensityScale } from './pedestrianColor';
import { meshFromPlanarFace } from './polygonMesh';

/** 峰值密度网格：每个三角面按 density 着色 */
export function pedestrianDensityToFills(result: PedestrianResult, scale = resolveDensityScale(result)): PolygonFill[] {
  const grid = result.densityGrid;
  if (!grid) return [];
  const fills: PolygonFill[] = [];
  for (let fi = 0; fi < grid.faces.length; fi++) {
    const face = grid.faces[fi];
    if (!face?.length) continue;
    const ring: [number, number][] = [];
    for (const vi of face) {
      const v = grid.vertices[vi];
      if (!v || v.length < 2) continue;
      ring.push([v[0], v[1]]);
    }
    if (ring.length < 3) continue;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      area += x0 * y1 - x1 * y0;
    }
    if (area < 0) ring.reverse();
    const mesh = meshFromPlanarFace(ring, 0.02 + fi * 0.0001);
    if (!mesh) continue;
    const d = grid.density[fi] ?? 0;
    fills.push({
      spaceId: grid.gridId,
      meshId: `ped-grid-${grid.gridId}-${fi}`,
      mesh,
      color: densityToColor(d, scale),
      opacity: 1,
    });
  }
  return fills;
}
