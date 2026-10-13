import type { Vec2 } from '@sdd/shared';
import { segmentOverlap } from './regions';

/** 在共线重叠的端点处分段，供开放边界和实体墙分别处理。 */
export function splitBoundarySegment(a: Vec2, b: Vec2, cuts: [Vec2, Vec2][]): [Vec2, Vec2][] {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (length2 < 1e-14) return [];
  const ts = [0, 1];
  for (const [c, d] of cuts) {
    const overlap = segmentOverlap(a, b, c, d);
    if (overlap) for (const p of overlap) ts.push(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2);
  }
  ts.sort((x, y) => x - y);
  const point = (t: number): Vec2 => [a[0] + t * dx, a[1] + t * dy];
  return ts.slice(1).flatMap((t, i) => (t - ts[i]) * Math.sqrt(length2) > 1e-7
    ? [[point(ts[i]), point(t)] as [Vec2, Vec2]] : []);
}

export function segmentCoveredBy(a: Vec2, b: Vec2, segments: [Vec2, Vec2][]): boolean {
  const parts = splitBoundarySegment(a, b, segments);
  return parts.length > 0 && parts.every(([c, d]) => segments.some(([e, f]) => {
    const overlap = segmentOverlap(c, d, e, f);
    return overlap && Math.abs(Math.hypot(d[0] - c[0], d[1] - c[1])
      - Math.hypot(overlap[1][0] - overlap[0][0], overlap[1][1] - overlap[0][1])) < 1e-6;
  }));
}

