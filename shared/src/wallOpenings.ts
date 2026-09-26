import type { Opening, Vec2, Wall } from './model';

/** 按真实洞口宽度截断墙中线；弧长位置支持多段折线和多个洞口。 */
export function wallSolidPolylines(wall: Wall, openings: Opening[]): Vec2[][] {
  const points = wall.geometry.points;
  const lengths = points.slice(1).map((p, i) => Math.hypot(p[0] - points[i][0], p[1] - points[i][1]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const cuts = openings.filter((o) => o.hostWallId === wall.id && Number.isFinite(o.position) && o.width > 0)
    .map((o) => [Math.max(0, o.position - o.width / 2), Math.min(total, o.position + o.width / 2)])
    .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const intervals: number[][] = [];
  let end = 0;
  for (const [a, b] of cuts) {
    if (a > end) intervals.push([end, a]);
    end = Math.max(end, b);
  }
  if (end < total) intervals.push([end, total]);
  return intervals.flatMap(([start, finish]) => {
    const result: Vec2[] = [];
    let offset = 0;
    for (let i = 0; i < lengths.length; i++) {
      const length = lengths[i];
      const lo = Math.max(start, offset), hi = Math.min(finish, offset + length);
      if (length > 1e-9 && hi > lo + 1e-9) {
        const at = (s: number): Vec2 => [points[i][0] + (points[i + 1][0] - points[i][0]) * (s - offset) / length,
          points[i][1] + (points[i + 1][1] - points[i][1]) * (s - offset) / length];
        if (!result.length) result.push(at(lo));
        result.push(at(hi));
      }
      offset += length;
    }
    return result.length >= 2 ? [result] : [];
  });
}
