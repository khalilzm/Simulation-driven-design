import type { SunlightResult } from '@sdd/shared';
import type { PolygonFill } from './modelRender';
import { hoursToSunlightColor, resolveSunlightColorScale } from './sunlightColor';
import { meshFromPlanarFace } from './polygonMesh';

/** Honeybee 传感器网格：每个三角面按 hours 着色 */
export function sunlightGridsToFills(result: SunlightResult): PolygonFill[] {
  const scale = resolveSunlightColorScale(result);
  const fills: PolygonFill[] = [];
  for (const grid of result.grids ?? []) {
    for (let fi = 0; fi < grid.faces.length; fi++) {
      const face = grid.faces[fi];
      if (!face?.length) continue;
      const ring: [number, number][] = [];
      let z = 0.02;
      for (const vi of face) {
        const v = grid.vertices[vi];
        if (!v || v.length < 2) continue;
        ring.push([v[0], v[1]]);
        if (v.length >= 3 && Number.isFinite(v[2])) z = v[2];
      }
      if (ring.length < 3) continue;
      // Honeybee 各网格绕向不一致（有的 CCW 有的 CW），归一化为 CCW，
      // 避免单面材质下 CW 网格整片被背面剔除。
      let area = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x0, y0] = ring[i];
        const [x1, y1] = ring[(i + 1) % ring.length];
        area += x0 * y1 - x1 * y0;
      }
      if (area < 0) ring.reverse();
      const mesh = meshFromPlanarFace(ring, z + fi * 0.0001);
      if (!mesh) continue;
      const h = grid.hours[fi] ?? 0;
      // 与 SunlightLegend 同一套 Ecotect 插值，避免 faceColors 与图例条肉眼不一致
      const color = hoursToSunlightColor(h, scale);
      fills.push({
        spaceId: grid.spaceId,
        meshId: `sun-grid-${grid.gridId}-${fi}`,
        mesh,
        color,
        opacity: 1,
      });
    }
  }
  return fills;
}
