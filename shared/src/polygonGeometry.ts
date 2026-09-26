import type { Vec2 } from './model';

const EPS = 1e-7;

export function isFinitePoint(value: unknown): value is Vec2 {
  return Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointOnSegment(p: Vec2, a: Vec2, b: Vec2, tolerance: number): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return distance(p, a) <= tolerance;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) <= tolerance;
}

function side(a: Vec2, b: Vec2, p: Vec2): number {
  const area = cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]);
  return Math.abs(area) <= EPS * distance(a, b) ? 0 : Math.sign(area);
}

function segmentsMeet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const abC = side(a, b, c);
  const abD = side(a, b, d);
  const cdA = side(c, d, a);
  const cdB = side(c, d, b);
  return (abC * abD < 0 && cdA * cdB < 0)
    || (abC === 0 && pointOnSegment(c, a, b, EPS))
    || (abD === 0 && pointOnSegment(d, a, b, EPS))
    || (cdA === 0 && pointOnSegment(a, c, d, EPS))
    || (cdB === 0 && pointOnSegment(b, c, d, EPS));
}

/** 模型只支持单个简单闭合环；自交、自接触及折返重叠不能送入三角化。 */
export function polygonGeometryError(input: unknown): string | null {
  if (!Array.isArray(input) || input.length < 4) return '边界点数不足（至少三个顶点及闭合点）';
  if (!input.every(isFinitePoint)) return '边界坐标须为有限数值 [x,y]';
  const pts = input as Vec2[];
  if (distance(pts[0], pts[pts.length - 1]) > 1e-6) return '边界未首尾闭合（最后一点须等于第一点）';
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const c = pts[(i + 2) % n];
    if (distance(a, b) <= EPS) return `边界含零长度边（第 ${i + 1} 边）`;
    if (side(a, b, c) === 0 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      return `边界折返重叠（第 ${i + 1}、${(i + 1) % n + 1} 边）`;
    }
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsMeet(a, b, pts[j], pts[(j + 1) % n])) {
        return `边界自交或自接触（第 ${i + 1}、${j + 1} 边）`;
      }
    }
  }
  // 使用相对首点的坐标，减少大原点对面积计算的影响。
  let twiceArea = 0;
  for (let i = 1; i + 1 < n; i++) {
    twiceArea += cross(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1], pts[i + 1][0] - pts[0][0], pts[i + 1][1] - pts[0][1]);
  }
  return Math.abs(twiceArea) <= 2e-9 ? '边界面积为零' : null;
}

export function pointInOrOnPolygon(point: Vec2, polygon: Vec2[], tolerance = EPS): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (pointOnSegment(point, a, b, tolerance)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}

/** 按与轮廓的所有交点分段检查，避免端点和单个中点漏掉窄凹口。 */
export function segmentOutsidePoint(from: Vec2, to: Vec2, polygon: Vec2[], tolerance = EPS): Vec2 | null {
  if (!pointInOrOnPolygon(from, polygon, tolerance)) return from;
  if (!pointInOrOnPolygon(to, polygon, tolerance)) return to;
  const rx = to[0] - from[0];
  const ry = to[1] - from[1];
  const length2 = rx * rx + ry * ry;
  if (length2 <= EPS * EPS) return null;
  const cuts = [0, 1];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const sx = b[0] - a[0];
    const sy = b[1] - a[1];
    const qx = a[0] - from[0];
    const qy = a[1] - from[1];
    const denominator = cross(rx, ry, sx, sy);
    const parallel = Math.abs(denominator) <= 1e-12 * Math.sqrt(length2 * (sx * sx + sy * sy));
    if (parallel || denominator === 0) {
      if (Math.abs(cross(qx, qy, rx, ry)) <= EPS * Math.sqrt(length2)) {
        cuts.push(Math.max(0, Math.min(1, (qx * rx + qy * ry) / length2)));
        cuts.push(Math.max(0, Math.min(1, ((b[0] - from[0]) * rx + (b[1] - from[1]) * ry) / length2)));
      }
      continue;
    }
    const t = cross(qx, qy, sx, sy) / denominator;
    const u = cross(qx, qy, rx, ry) / denominator;
    if (t >= 0 && t <= 1 && u >= -1e-10 && u <= 1 + 1e-10) cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t = (cuts[i] + cuts[i + 1]) / 2;
    const p: Vec2 = [from[0] + rx * t, from[1] + ry * t];
    if (!pointInOrOnPolygon(p, polygon, tolerance)) return p;
  }
  return null;
}

export interface OutsideBoundaryEdge {
  from: Vec2;
  to: Vec2;
  point: Vec2;
}

/** 调用方先检查两个多边形的简单环合法性。 */
/** 去掉首尾重合的闭合点，得到开环顶点序列 */
export function openPolygonRing(pts: Vec2[]): Vec2[] {
  if (pts.length < 2) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 1e-6) return pts.slice(0, -1);
  return pts;
}

/** 多边形面积质心（用于功能区标签定位） */
export function polygonCentroid(pts: Vec2[]): Vec2 {
  const ring = openPolygonRing(pts);
  if (ring.length < 3) {
    if (ring.length === 0) return [0, 0];
    if (ring.length === 1) return ring[0];
    return [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2];
  }
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) return ring[0];
  return [cx / (6 * area), cy / (6 * area)];
}

function closePolygonRing(pts: Vec2[]): Vec2[] {
  const ring = openPolygonRing(pts);
  if (ring.length < 3) return ring;
  return [...ring, ring[0]];
}

/**
 * 功能区标签锚点：优先面积质心；凹多边形质心落在外部时改用包围盒中心或顶点均值。
 */
export function polygonInteriorLabelPoint(pts: Vec2[]): Vec2 {
  const ring = openPolygonRing(pts);
  if (ring.length === 0) return [0, 0];
  if (ring.length === 1) return ring[0];
  if (ring.length === 2) return [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2];

  const closed = closePolygonRing(pts);
  const centroid = polygonCentroid(pts);
  if (pointInOrOnPolygon(centroid, closed)) return centroid;

  let minX = ring[0][0];
  let maxX = ring[0][0];
  let minY = ring[0][1];
  let maxY = ring[0][1];
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const boxCenter: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2];
  if (pointInOrOnPolygon(boxCenter, closed)) return boxCenter;

  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  const vertexMean: Vec2 = [sx / ring.length, sy / ring.length];
  if (pointInOrOnPolygon(vertexMean, closed)) return vertexMean;

  return ring[0];
}

/** 多边形轴对齐包围盒的最短边长（米），用于标签字号缩放 */
export function polygonBBoxMinExtent(pts: Vec2[]): number {
  const ring = openPolygonRing(pts);
  if (ring.length === 0) return 0;
  let minX = ring[0][0];
  let maxX = ring[0][0];
  let minY = ring[0][1];
  let maxY = ring[0][1];
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

export function findBoundaryOutside(inner: Vec2[], outer: Vec2[], tolerance = EPS): OutsideBoundaryEdge | null {
  for (let i = 0; i < inner.length; i++) {
    const from = inner[i];
    const to = inner[(i + 1) % inner.length];
    const point = segmentOutsidePoint(from, to, outer, tolerance);
    if (point) return { from, to, point };
  }
  return null;
}
