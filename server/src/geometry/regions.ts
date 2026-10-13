import { diff, intersection, union, type Geometry, type MultiPolygon, type Polygon } from 'martinez-polygon-clipping';
import { polygonGeometryError, type Vec2 } from '@sdd/shared';
import { boundsOf, closePolygon, polygonArea } from './polygon';

export const GEOMETRY_EPS = 1e-7;

export function polygons(geometry: Geometry | null): MultiPolygon {
  if (!geometry?.length) return [];
  return typeof geometry[0][0][0] === 'number' ? [geometry as Polygon] : geometry as MultiPolygon;
}

export function geometryArea(geometry: Geometry | null): number {
  return polygons(geometry).reduce((area, rings) => area + polygonArea(rings[0])
    - rings.slice(1).reduce((holes, ring) => holes + polygonArea(ring), 0), 0);
}

/** 清除重复/共线点及 1e-9 单位以下的浮点噪声。 */
export function cleanRing(points: Vec2[]): Vec2[] {
  const ring: Vec2[] = [];
  for (const raw of points) {
    const p: Vec2 = [Number(raw[0].toFixed(9)), Number(raw[1].toFixed(9))];
    if (!ring.length || Math.hypot(p[0] - ring.at(-1)![0], p[1] - ring.at(-1)![1]) > GEOMETRY_EPS) ring.push([...p]);
  }
  if (ring.length > 1 && Math.hypot(ring[0][0] - ring.at(-1)![0], ring[0][1] - ring.at(-1)![1]) <= GEOMETRY_EPS) ring.pop();
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cross) <= GEOMETRY_EPS * Math.hypot(c[0] - a[0], c[1] - a[1])) {
        ring.splice(i, 1); changed = true; break;
      }
    }
  }
  return closePolygon(ring, 0);
}

function convex(ring: Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i], b = ring[(i + 1) % (ring.length - 1)], c = ring[(i + 2) % (ring.length - 1)];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) <= GEOMETRY_EPS) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

export function rectangle(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

export function unionRings(rings: Vec2[][]): MultiPolygon {
  let result: Geometry = rings.length ? [rings[0]] : [];
  for (const ring of rings.slice(1)) result = union(result, [ring]) ?? [];
  return polygons(result);
}

/** 精确的竖向条带分解，再合并相邻凸区域；凹口、斜边、孔洞均保留。 */
export function decomposeRegions(geometry: Geometry): Vec2[][] {
  const source = polygons(geometry);
  const points = source.flat(2);
  const bounds = boundsOf(points);
  if (!bounds) return [];
  const xs = [...new Set(points.map((p) => p[0]))].sort((a, b) => a - b);
  const cells: Vec2[][] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] <= GEOMETRY_EPS) continue;
    const strip = rectangle(xs[i], bounds.minY - 1, xs[i + 1], bounds.maxY + 1);
    for (const polygon of polygons(intersection(geometry, [strip]))) {
      if (polygon.length !== 1) throw new Error('可用区域分解仍含孔洞');
      const ring = cleanRing(polygon[0]);
      if (polygonArea(ring) <= 1e-9) continue;
      const error = polygonGeometryError(ring);
      if (error || !convex(ring)) throw new Error(`可用区域分解失败：${error ?? '非凸区域'}`);
      cells.push(ring);
    }
  }
  // 只合并共享边的区域，合并后保持凸性，便于在单次输出中可靠切分。
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
        if (!sharedSegments(cells[i], cells[j]).length) continue;
        const merged = polygons(union([cells[i]], [cells[j]]));
        if (merged.length !== 1 || merged[0].length !== 1) continue;
        const ring = cleanRing(merged[0][0]);
        if (ring.length > 9 || polygonGeometryError(ring) || !convex(ring)) continue;
        cells[i] = ring; cells.splice(j, 1); changed = true; break outer;
      }
    }
  }
  return cells.sort((a, b) => {
    const x = boundsOf(a)!, y = boundsOf(b)!;
    return x.minX - y.minX || x.minY - y.minY || polygonArea(b) - polygonArea(a);
  });
}

/** 两条线段的正长度共线交集，顶点接触不算邻接。 */
export function segmentOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): [Vec2, Vec2] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
  if (length <= GEOMETRY_EPS) return null;
  const cross = (p: Vec2) => Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length;
  if (cross(c) > GEOMETRY_EPS || cross(d) > GEOMETRY_EPS) return null;
  const t = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length ** 2;
  const lo = Math.max(0, Math.min(t(c), t(d))), hi = Math.min(1, Math.max(t(c), t(d)));
  if ((hi - lo) * length <= GEOMETRY_EPS) return null;
  return [[a[0] + lo * dx, a[1] + lo * dy], [a[0] + hi * dx, a[1] + hi * dy]];
}

export function sharedSegments(a: Vec2[], b: Vec2[]): [Vec2, Vec2][] {
  const shared: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < a.length; i++) for (let j = 0; j + 1 < b.length; j++) {
    const segment = segmentOverlap(a[i], a[i + 1], b[j], b[j + 1]);
    if (segment) shared.push(segment);
  }
  return shared;
}

export function splitRegion(boundary: Vec2[], axis: 'x' | 'y', ratio: number): [Vec2[], Vec2[]] {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) throw new Error('split.ratio 必须在 0 和 1 之间');
  const b = boundsOf(boundary)!;
  const at = axis === 'x' ? b.minX + (b.maxX - b.minX) * ratio : b.minY + (b.maxY - b.minY) * ratio;
  const masks = axis === 'x'
    ? [rectangle(b.minX - 1, b.minY - 1, at, b.maxY + 1), rectangle(at, b.minY - 1, b.maxX + 1, b.maxY + 1)]
    : [rectangle(b.minX - 1, b.minY - 1, b.maxX + 1, at), rectangle(b.minX - 1, at, b.maxX + 1, b.maxY + 1)];
  return masks.map((mask) => {
    const result = polygons(intersection([boundary], [mask]));
    if (result.length !== 1 || result[0].length !== 1) throw new Error('切分产生不连通或空区域');
    const ring = cleanRing(result[0][0]);
    if (polygonGeometryError(ring)) throw new Error('切分产生无效区域');
    return ring;
  }) as [Vec2[], Vec2[]];
}

export function outsideArea(boundary: Vec2[], floor: Vec2[]): number {
  return geometryArea(diff([boundary], [floor]));
}

export { intersection };
