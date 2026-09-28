import { pointInOrOnPolygon } from '@sdd/shared';
import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../model/geometry';
import { segmentOverlap } from './regionGeometry';

const SNAP = 0.02;

function dist2(a: Vec2, b: Vec2): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/** 将点吸附到 floor 顶点或外轮廓边上的最近合法位置。 */
export function snapPointToFloorPlan(point: Vec2, floorBoundary: Vec2[]): Vec2 {
  const floor = closePolygon(floorBoundary, 0);
  if (pointInOrOnPolygon(point, floor, 1e-6)) return point;
  let best: Vec2 = point;
  let bestD = Infinity;
  for (const corner of floor.slice(0, -1)) {
    const d = dist2(point, corner);
    if (d < bestD) { bestD = d; best = corner; }
  }
  for (let i = 0; i + 1 < floor.length; i++) {
    const a = floor[i], b = floor[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    if (len2 < 1e-14) continue;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2));
    const q: Vec2 = [a[0] + t * dx, a[1] + t * dy];
    const d = dist2(point, q);
    if (d < bestD) { bestD = d; best = q; }
  }
  if (bestD <= SNAP ** 2) return [Number(best[0].toFixed(6)), Number(best[1].toFixed(6))];
  return point;
}

export function snapSpaceBoundaryToFloorPlan(boundary: Vec2[], floorBoundary: Vec2[]): Vec2[] {
  const ring = closePolygon(boundary, 0);
  const snapped = ring.slice(0, -1).map((point) => snapPointToFloorPlan(point, floorBoundary));
  const deduped: Vec2[] = [];
  for (const point of snapped) {
    if (!deduped.length || dist2(point, deduped.at(-1)!) > 1e-12) deduped.push(point);
  }
  return closePolygon(deduped, 0);
}

/** 边是否落在外轮廓或给定内部分界线段上。 */
export function edgeOnSegments(a: Vec2, b: Vec2, segments: [Vec2, Vec2][], tolerance = 1e-4): boolean {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < tolerance) return false;
  return segments.some(([c, d]) => {
    const overlap = segmentOverlap(a, b, c, d);
    if (!overlap) return false;
    return Math.abs(Math.hypot(overlap[1][0] - overlap[0][0], overlap[1][1] - overlap[0][1]) - length) < tolerance;
  });
}
