import type { Vec2 } from '@sdd/shared';
import { intersection, type MultiPolygon, type Polygon } from 'martinez-polygon-clipping';
import { findBoundaryOutside, isFinitePoint, polygonGeometryError, segmentOutsidePoint } from '@sdd/shared';

/** shoelace 多边形面积（绝对值） */
export function polygonArea(points: Vec2[]): number {
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** 多边形首尾是否闭合（最后一点与第一点重合） */
export function isPolygonClosed(points: Vec2[], eps = 1e-6): boolean {
  if (points.length < 3) return false;
  const [x0, y0] = points[0];
  const [xn, yn] = points[points.length - 1];
  return Math.hypot(x0 - xn, y0 - yn) <= eps;
}

/** 简单闭合多边形：有限坐标、无自交/重叠且面积>0。 */
export function isValidPolygon(points: unknown): boolean {
  return polygonGeometryError(points) === null;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(points: Vec2[]): Bounds | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function roundCoord(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** 平移到原点并保留固定小数位，返回归一化边界与原始 origin */
export function normalizePolygon(points: Vec2[], decimals = 3): { boundary: Vec2[]; origin: Vec2 } {
  const b = boundsOf(points);
  if (!b) return { boundary: points, origin: [0, 0] };
  const origin: Vec2 = [b.minX, b.minY];
  const boundary = points.map(
    ([x, y]) => [roundCoord(x - origin[0], decimals), roundCoord(y - origin[1], decimals)] as Vec2,
  );
  return { boundary, origin };
}

export interface OutlineBBox {
  width: number;
  height: number;
  area: number;
}

export function outlineBBox(boundary: Vec2[]): OutlineBBox | null {
  const b = boundsOf(boundary);
  if (!b) return null;
  return {
    width: roundCoord(b.maxX - b.minX),
    height: roundCoord(b.maxY - b.minY),
    area: roundCoord(polygonArea(boundary), 2),
  };
}

const DEFAULT_CONTAIN_TOL = 0.02;

function distPointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-18) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const qx = x1 + t * dx;
  const qy = y1 + t * dy;
  return Math.hypot(px - qx, py - qy);
}

/** 点是否在多边形内部（不含边界） */
export function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  const [x, y] = point;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 点是否在多边形内部或落在边界上（允许小容差） */
export function pointInPolygonOrOnEdge(
  point: Vec2,
  polygon: Vec2[],
  tolerance = DEFAULT_CONTAIN_TOL,
): boolean {
  if (pointInPolygon(point, polygon)) return true;
  const [x, y] = point;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % n];
    if (distPointToSegment(x, y, x1, y1, x2, y2) <= tolerance) return true;
  }
  return false;
}

/** 检查每条线段在所有轮廓交点间均位于内部或边界上。 */
export function polylineContainedInPolygon(
  points: Vec2[],
  polygon: Vec2[],
  tolerance = DEFAULT_CONTAIN_TOL,
): boolean {
  if (points.length === 0) return true;
  if (!points.every(isFinitePoint)) return false;
  for (const p of points) {
    if (!pointInPolygonOrOnEdge(p, polygon, tolerance)) return false;
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (segmentOutsidePoint(p0, p1, polygon, tolerance)) return false;
  }
  return true;
}

/** 多边形所有顶点是否落在外轮廓内或边界上 */
/** 若首尾不重合则补上起点，使多边形闭合 */
export function closePolygon(boundary: Vec2[], tolerance = 1e-3): Vec2[] {
  if (boundary.length < 3) return boundary;
  const first = boundary[0];
  const last = boundary[boundary.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= tolerance) return boundary;
  return [...boundary, first];
}

export function polygonContainedInPolygon(
  inner: Vec2[],
  outer: Vec2[],
  tolerance = DEFAULT_CONTAIN_TOL,
): boolean {
  for (const p of inner) {
    if (!pointInPolygonOrOnEdge(p, outer, tolerance)) return false;
  }
  return true;
}

/** 每条完整边均须留在外轮廓内，检查窄凹口及多次进出。 */
export function polygonEdgesContainedInPolygon(
  inner: Vec2[],
  outer: Vec2[],
  tolerance = DEFAULT_CONTAIN_TOL,
): boolean {
  return inner.length >= 3 && findBoundaryOutside(inner, outer, tolerance) === null;
}

/** 返回第一条穿出外轮廓的边（用于校验报错） */
export function findPolygonEdgeOutside(
  inner: Vec2[],
  outer: Vec2[],
  tolerance = DEFAULT_CONTAIN_TOL,
): { from: Vec2; to: Vec2; point: Vec2 } | null {
  return inner.length >= 3 ? findBoundaryOutside(inner, outer, tolerance) : null;
}

/** 两多边形是否存在面积重叠（共享边贴邻不算重叠） */
export function polygonsHaveAreaOverlap(a: Vec2[], b: Vec2[]): boolean {
  // 无效多边形由调用方报告；布尔运算不能接收自交边界。
  if (polygonGeometryError(a) || polygonGeometryError(b)) return false;
  const overlap = intersection([closePolygon(a, 0)], [closePolygon(b, 0)]);
  if (!overlap?.length) return false;
  const regions = typeof overlap[0][0][0] === 'number' ? [overlap as Polygon] : overlap as MultiPolygon;
  return regions.some((rings) => polygonArea(rings[0])
    - rings.slice(1).reduce((holes, ring) => holes + polygonArea(ring), 0) > 1e-6);
}

export interface LineSegment {
  from: Vec2;
  to: Vec2;
}

const DEFAULT_PARTITION_TOL = 0.05;

function pointOnSegment(p: Vec2, a: Vec2, b: Vec2, tol: number): boolean {
  return distPointToSegment(p[0], p[1], a[0], a[1], b[0], b[1]) <= tol;
}

/** 边 inner 是否完全落在容器边 container 上（共线且为子线段） */
function segmentContainedInSegment(container: LineSegment, inner: LineSegment, tol: number): boolean {
  return (
    pointOnSegment(inner.from, container.from, container.to, tol) &&
    pointOnSegment(inner.to, container.from, container.to, tol)
  );
}

function segmentsFromClosedRing(ring: Vec2[]): LineSegment[] {
  if (ring.length < 3) return [];
  const closed = isPolygonClosed(ring, 1e-6);
  const n = closed ? ring.length - 1 : ring.length;
  const segs: LineSegment[] = [];
  for (let i = 0; i < n; i++) {
    segs.push({ from: ring[i], to: ring[(i + 1) % ring.length] });
  }
  return segs;
}

function segmentsFromPolyline(points: Vec2[]): LineSegment[] {
  const segs: LineSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    segs.push({ from: points[i], to: points[i + 1] });
  }
  return segs;
}

/** 由 floor 外轮廓 + 内隔墙折线构成的平面分割边集 */
export function buildPartitionSegments(
  floorBoundary: Vec2[],
  interiorWallPolylines: Vec2[][],
): LineSegment[] {
  const segs = segmentsFromClosedRing(floorBoundary);
  for (const pts of interiorWallPolylines) {
    segs.push(...segmentsFromPolyline(pts));
  }
  return segs;
}

function edgeOnPartition(edge: LineSegment, partition: LineSegment[], tol: number): boolean {
  const len = Math.hypot(edge.to[0] - edge.from[0], edge.to[1] - edge.from[1]);
  if (len < 1e-9) return true;
  for (const p of partition) {
    if (segmentContainedInSegment(p, edge, tol)) return true;
  }
  return false;
}

/** space 的每条边是否都落在分割边（外墙轮廓段或内墙段）上 */
export function spaceBoundaryOnPartition(
  spaceBoundary: Vec2[],
  partition: LineSegment[],
  tol = DEFAULT_PARTITION_TOL,
): boolean {
  return findSpaceEdgeNotOnPartition(spaceBoundary, partition, tol) === null;
}

/** 返回第一条不在分割边上的 space 边 */
export function findSpaceEdgeNotOnPartition(
  spaceBoundary: Vec2[],
  partition: LineSegment[],
  tol = DEFAULT_PARTITION_TOL,
): LineSegment | null {
  if (spaceBoundary.length < 3) return null;
  const closed = isPolygonClosed(spaceBoundary, 1e-6);
  const n = closed ? spaceBoundary.length - 1 : spaceBoundary.length;
  for (let i = 0; i < n; i++) {
    const edge = { from: spaceBoundary[i], to: spaceBoundary[(i + 1) % spaceBoundary.length] };
    if (!edgeOnPartition(edge, partition, tol)) return edge;
  }
  return null;
}

/** 点是否在多边形边界折线上 */
export function pointOnPolygonBoundary(p: Vec2, ring: Vec2[], tol = DEFAULT_PARTITION_TOL): boolean {
  if (ring.length < 2) return false;
  const closed = isPolygonClosed(ring, 1e-6);
  const n = closed ? ring.length - 1 : ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (pointOnSegment(p, a, b, tol)) return true;
  }
  return false;
}

/** 沿墙折线 position（米）处的点 */
export function pointAlongWallPolyline(points: Vec2[], position: number): Vec2 | null {
  if (points.length < 2) return null;
  let acc = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    if (position <= acc + len + 1e-9) {
      const t = Math.max(0, Math.min(1, (position - acc) / len));
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += len;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

/** 门洞中心贴边的 space id（按门位判断，非整段墙） */
export function findSpaceIdsAtDoor(
  wallPoints: Vec2[],
  position: number,
  spaces: { id: string; boundary: Vec2[] }[],
  tol = DEFAULT_PARTITION_TOL,
): string[] {
  const doorPoint = pointAlongWallPolyline(wallPoints, position);
  if (!doorPoint) return [];
  return spaces
    .filter((s) => pointOnPolygonBoundary(doorPoint, s.boundary, tol))
    .map((s) => s.id);
}

/** space 边界边是否落在墙折线上 */
export function spaceBoundaryEdgeOnPolyline(
  edge: LineSegment,
  polyline: Vec2[],
  tol = DEFAULT_PARTITION_TOL,
): boolean {
  for (const ws of segmentsFromPolyline(polyline)) {
    if (segmentContainedInSegment(ws, edge, tol)) return true;
  }
  return false;
}

/** 墙折线贴边的 space id（交通区无 space 时不出现） */
export function findSpaceIdsAdjacentToWall(
  wallPoints: Vec2[],
  spaces: { id: string; boundary: Vec2[] }[],
  tol = DEFAULT_PARTITION_TOL,
): string[] {
  const ids: string[] = [];
  for (const space of spaces) {
    const ring = space.boundary;
    if (ring.length < 3) continue;
    const closed = isPolygonClosed(ring, 1e-6);
    const n = closed ? ring.length - 1 : ring.length;
    let onWall = false;
    for (let i = 0; i < n; i++) {
      const edge = { from: ring[i], to: ring[(i + 1) % ring.length] };
      if (spaceBoundaryEdgeOnPolyline(edge, wallPoints, tol)) {
        onWall = true;
        break;
      }
    }
    if (onWall) ids.push(space.id);
  }
  return ids;
}
