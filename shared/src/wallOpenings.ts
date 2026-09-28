import type { Opening, Vec2, Wall } from './model';

function wallLengths(points: Vec2[]): { lengths: number[]; total: number } {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return { lengths, total };
}

/** 取墙折线上 [start, finish] 弧长区间对应的子折线。 */
function subPolyline(points: Vec2[], start: number, finish: number): Vec2[] {
  const { lengths } = wallLengths(points);
  const result: Vec2[] = [];
  let offset = 0;
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i];
    const lo = Math.max(start, offset);
    const hi = Math.min(finish, offset + length);
    if (length > 1e-9 && hi > lo + 1e-9) {
      const at = (s: number): Vec2 => [
        points[i][0] + (points[i + 1][0] - points[i][0]) * (s - offset) / length,
        points[i][1] + (points[i + 1][1] - points[i][1]) * (s - offset) / length,
      ];
      if (!result.length) result.push(at(lo));
      result.push(at(hi));
    }
    offset += length;
  }
  return result;
}

/** 按真实洞口宽度截断墙中线（平面视图）；弧长位置支持多段折线和多个洞口。 */
export function wallSolidPolylines(wall: Wall, openings: Opening[]): Vec2[][] {
  const points = wall.geometry.points;
  const { total } = wallLengths(points);
  const cuts = openings
    .filter((o) => o.hostWallId === wall.id && Number.isFinite(o.position) && o.width > 0)
    .map((o) => [Math.max(0, o.position - o.width / 2), Math.min(total, o.position + o.width / 2)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const intervals: [number, number][] = [];
  let end = 0;
  for (const [a, b] of cuts) {
    if (a > end) intervals.push([end, a]);
    end = Math.max(end, b);
  }
  if (end < total) intervals.push([end, total]);
  return intervals.flatMap(([start, finish]) => {
    const result = subPolyline(points, start, finish);
    return result.length >= 2 ? [result] : [];
  });
}

export interface WallSolidPrism {
  points: Vec2[];
  z0: number;
  z1: number;
}

function subtractRanges(base: [number, number], cuts: [number, number][]): [number, number][] {
  const sorted = cuts.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let start = base[0];
  for (const [a, b] of sorted) {
    if (b <= start) continue;
    if (a > start) out.push([start, a]);
    start = Math.max(start, b);
    if (start >= base[1]) break;
  }
  if (start < base[1]) out.push([start, base[1]]);
  return out;
}

/**
 * 3D 墙体实体段：在 (弧长 × 高度) 平面按门/窗的真实高度与窗台高度做布尔减。
 * 门为 [0, height]，窗为 [sillHeight, sillHeight + height]，墙其余部分保持实体。
 */
export function wallSolidPrisms(wall: Wall, openings: Opening[]): WallSolidPrism[] {
  const points = wall.geometry.points;
  if (points.length < 2) return [];
  const H = wall.height;
  if (!(H > 0)) return [];
  const { total } = wallLengths(points);
  if (total < 1e-9) return [];

  const voids = openings
    .filter((o) => o.hostWallId === wall.id && Number.isFinite(o.position) && o.width > 0 && o.height > 0)
    .map((o) => {
      const l0 = Math.max(0, o.position - o.width / 2);
      const l1 = Math.min(total, o.position + o.width / 2);
      const z0 = Math.max(0, o.sillHeight ?? 0);
      const z1 = Math.min(H, z0 + o.height);
      return { l0, l1, z0, z1 };
    })
    .filter((v) => v.l1 - v.l0 > 1e-9 && v.z1 - v.z0 > 1e-9);

  const breaks = new Set<number>([0, total]);
  for (const v of voids) {
    breaks.add(v.l0);
    breaks.add(v.l1);
  }
  const xs = [...breaks].sort((a, b) => a - b);

  const prisms: WallSolidPrism[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const s0 = xs[i];
    const s1 = xs[i + 1];
    if (s1 - s0 < 1e-9) continue;
    const zCuts = voids
      .filter((v) => v.l0 < s1 - 1e-9 && v.l1 > s0 + 1e-9)
      .map((v) => [v.z0, v.z1] as [number, number]);
    const solid = subtractRanges([0, H], zCuts);
    const pts = subPolyline(points, s0, s1);
    if (pts.length < 2) continue;
    for (const [z0, z1] of solid) prisms.push({ points: pts, z0, z1 });
  }
  return prisms;
}
