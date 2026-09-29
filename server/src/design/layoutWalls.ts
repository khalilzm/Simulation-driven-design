import type { Vec2, Wall } from '@sdd/shared';
import { segmentOverlap } from './regionGeometry';

/** 仅增补未被既有墙覆盖的区间；保持门窗宿主墙的 ID 和几何。 */
export function appendWalls(walls: Wall[], rings: Vec2[][], height: number, thickness: number, idPrefix = 'layout-wall'): void {
  for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
    appendWallSegment(walls, ring[i], ring[i + 1], height, thickness, idPrefix);
  }
}

export function wallPolylineLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return total;
}

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

/** 用洞口两端的实际坐标定位宿主，同时处理反向墙和折线累计距离。 */
export function locateOpeningHost(walls: Wall[], a: Vec2, b: Vec2): { hostWallId: string; position: number } | null {
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  for (const wall of walls) {
    const positionAt = (p: Vec2): number | null => {
      let offset = 0;
      const points = wall.geometry.points;
      for (let i = 0; i + 1 < points.length; i++) {
        const c = points[i], d = points[i + 1];
        const dx = d[0] - c[0], dy = d[1] - c[1], length = Math.hypot(dx, dy);
        if (!length) continue;
        const s = ((p[0] - c[0]) * dx + (p[1] - c[1]) * dy) / length;
        const distance = Math.abs(dx * (p[1] - c[1]) - dy * (p[0] - c[0])) / length;
        if (distance < 1e-6 && s >= -1e-6 && s <= length + 1e-6) return offset + s;
        offset += length;
      }
      return null;
    };
    const start = positionAt(a), end = positionAt(b);
    if (start !== null && end !== null && Math.abs(Math.abs(end - start) - width) < 1e-6) {
      return { hostWallId: wall.id, position: (start + end) / 2 };
    }
  }
  return null;
}

/** 在 a→b 上追加墙段，返回新建或复用的墙 ID（整段被覆盖时返回 null）。 */
export function appendWallSegment(
  walls: Wall[],
  a: Vec2,
  b: Vec2,
  height: number,
  thickness: number,
  idPrefix = 'layout-wall',
  preferredId?: string,
): string | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (length2 < 1e-14) return null;
  const position = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
  const covered: [number, number][] = [];
  for (const wall of walls) for (let j = 0; j + 1 < wall.geometry.points.length; j++) {
    const overlap = segmentOverlap(a, b, wall.geometry.points[j], wall.geometry.points[j + 1]);
    if (overlap) covered.push([position(overlap[0]), position(overlap[1])]);
  }
  covered.sort((x, y) => x[0] - y[0]);
  let cursor = 0;
  const gaps: [number, number][] = [];
  for (const [start, end] of covered) {
    if (start > cursor + 1e-8) gaps.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < 1 - 1e-8) gaps.push([cursor, 1]);
  if (!gaps.length) return findHostWallId(walls, a, b);
  const point = (t: number): Vec2 => [a[0] + t * dx, a[1] + t * dy];
  let lastId: string | null = null;
  for (const [start, end] of gaps) {
    const id = preferredId && gaps.length === 1 ? preferredId : nextWallId(walls, idPrefix);
    walls.push({
      id,
      geometry: { type: 'polyline', points: [point(start), point(end)] },
      height,
      thickness,
      fixed: false,
    });
    lastId = id;
  }
  return lastId ?? findHostWallId(walls, a, b);
}

function nextWallId(walls: Wall[], prefix: string): string {
  let n = walls.length + 1;
  while (walls.some((wall) => wall.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/** 查找与线段 ab 共线重叠最多的墙，供洞口宿主引用。 */
export function findHostWallId(walls: Wall[], a: Vec2, b: Vec2): string | null {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  if (length2 < 1e-14) return null;
  const position = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
  let best: { id: string; span: number } | null = null;
  for (const wall of walls) {
    const points = wall.geometry.points;
    for (let j = 0; j + 1 < points.length; j++) {
      const overlap = segmentOverlap(a, b, points[j], points[j + 1]);
      if (!overlap) continue;
      const span = position(overlap[1]) - position(overlap[0]);
      if (!best || span > best.span) best = { id: wall.id, span };
    }
  }
  return best?.id ?? null;
}

export interface WallCandidate {
  a: Vec2;
  b: Vec2;
  preferredId?: string;
}

/** 同一支撑直线判定的容差（米）：远大于浮点噪声（≤1e-6），远小于有意义墙体间距。 */
export const WALL_SNAP_TOL = 1e-4;

interface WallLineParams {
  nx: number;
  ny: number;
  c: number;
}

function wallLineParams(a: Vec2, b: Vec2): WallLineParams | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < WALL_SNAP_TOL) return null;
  let nx = -dy / len, ny = dx / len;
  if (nx < 0 || (nx === 0 && ny < 0)) { nx = -nx; ny = -ny; }
  return { nx, ny, c: nx * a[0] + ny * a[1] };
}

function wallLineKey(a: Vec2, b: Vec2): string | null {
  const p = wallLineParams(a, b);
  if (!p) return null;
  const q = (v: number) => Math.round(v / WALL_SNAP_TOL);
  return `${q(p.nx)},${q(p.ny)},${q(p.c)}`;
}

function mergeIntervals(intervals: [number, number][]): [number, number][] {
  const sorted = intervals
    .filter(([a, b]) => b - a > 1e-9)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || a > last[1] + 1e-9) merged.push([a, b]);
    else if (b > last[1]) last[1] = b;
  }
  return merged;
}

function subtractIntervals(intervals: [number, number][], covered: [number, number][]): [number, number][] {
  const sorted = mergeIntervals(covered);
  const out: [number, number][] = [];
  for (let [a, b] of intervals) {
    for (const [c, d] of sorted) {
      if (d <= a) continue;
      if (c >= b) break;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}

/**
 * 用图算法生成墙：把候选墙段按支撑直线分组，对每组做共线区间的并集，
 * 再减去已保留墙的覆盖区间，每条极大区间只产出一条墙。从构造上杜绝一根墙线上的重复墙体。
 */
export function buildWallsFromSegments(
  candidates: WallCandidate[],
  height: number,
  thickness: number,
  idPrefix = 'layout-wall',
  retained: Wall[] = [],
): Wall[] {
  const groups = new Map<string, { a: Vec2; b: Vec2; preferredId?: string }[]>();
  for (const candidate of candidates) {
    const key = wallLineKey(candidate.a, candidate.b);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) groups.set(key, group = []);
    group.push(candidate);
  }

  const usedIds = new Set(retained.map((wall) => wall.id));
  let counter = 0;
  const nextId = (): string => {
    let id: string;
    do { id = `${idPrefix}-${++counter}`; } while (usedIds.has(id));
    return id;
  };

  const out: Wall[] = [];
  for (const group of groups.values()) {
    let nx = 0, ny = 0, cc = 0;
    for (const candidate of group) {
      const p = wallLineParams(candidate.a, candidate.b)!;
      nx += p.nx; ny += p.ny; cc += p.c;
    }
    const n = Math.hypot(nx, ny);
    nx /= n; ny /= n; cc /= group.length;
    // 方向 d̂ = (ny, -nx)，与法向量垂直；参数 t 沿 d̂，p0 = c·n 在直线上。
    const proj = (p: Vec2): number => ny * p[0] - nx * p[1];
    const pointAt = (t: number): Vec2 => [cc * nx + t * ny, cc * ny - t * nx];

    const intervals: [number, number][] = [];
    for (const candidate of group) {
      const t0 = proj(candidate.a), t1 = proj(candidate.b);
      intervals.push([Math.min(t0, t1), Math.max(t0, t1)]);
    }
    const covered: [number, number][] = [];
    for (const wall of retained) {
      const points = wall.geometry.points;
      for (let j = 0; j + 1 < points.length; j++) {
        const p = wallLineParams(points[j], points[j + 1]);
        if (!p) continue;
        const q = (v: number) => Math.round(v / WALL_SNAP_TOL);
        if (q(p.nx) !== q(nx) || q(p.ny) !== q(ny) || q(p.c) !== q(cc)) continue;
        const t0 = proj(points[j]), t1 = proj(points[j + 1]);
        covered.push([Math.min(t0, t1), Math.max(t0, t1)]);
      }
    }

    const unioned = mergeIntervals(intervals);
    for (const [t0, t1] of subtractIntervals(unioned, covered)) {
      const owner = group.find((candidate) => {
        const a = proj(candidate.a), b = proj(candidate.b);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return Math.abs(lo - t0) < WALL_SNAP_TOL && Math.abs(hi - t1) < WALL_SNAP_TOL;
      });
      const id = owner?.preferredId ?? nextId();
      usedIds.add(id);
      let p0 = pointAt(t0), p1 = pointAt(t1);
      if (owner && proj(owner.a) > proj(owner.b)) [p0, p1] = [p1, p0];
      out.push({
        id,
        geometry: { type: 'polyline', points: [p0, p1] },
        height,
        thickness,
        fixed: false,
      });
    }
  }
  return out;
}
