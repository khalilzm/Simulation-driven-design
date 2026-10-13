import type { SpaceModel, Vec2 } from '@sdd/shared';
import { polygonGeometryError } from '@sdd/shared';
import { diff, type Geometry, type MultiPolygon, type Polygon } from 'martinez-polygon-clipping';
import { closePolygon, polygonArea } from '../geometry/polygon';

function polygons(geometry: Geometry | null): MultiPolygon {
  if (!geometry?.length) return [];
  return typeof geometry[0][0][0] === 'number'
    ? [geometry as Polygon]
    : geometry as MultiPolygon;
}

/** 布尔差集保留孔洞及多个连通分量；不以面积之和代替覆盖检查。 */
export function uncoveredFloorRegions(model: SpaceModel): MultiPolygon {
  let remaining: Geometry | null = [closePolygon(model.floor.boundary, 0)];
  for (const space of model.spaces) {
    if (!remaining?.length) break;
    remaining = diff(remaining, [closePolygon(space.boundary, 0)]);
  }
  return polygons(remaining);
}

function uncoveredWallInterval(
  from: Vec2,
  to: Vec2,
  walls: SpaceModel['walls'],
  tolerance: number,
): [number, number] | null {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length <= tolerance) return null;
  const intervals: [number, number][] = [];
  for (const wall of walls) {
    const points = wall.geometry.points;
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const distance = (p: Vec2) => Math.abs(dx * (p[1] - from[1]) - dy * (p[0] - from[0])) / length;
      if (distance(a) > tolerance || distance(b) > tolerance) continue;
      const position = (p: Vec2) => ((p[0] - from[0]) * dx + (p[1] - from[1]) * dy) / length;
      const start = Math.max(0, Math.min(position(a), position(b)));
      const end = Math.min(length, Math.max(position(a), position(b)));
      if (end > start) intervals.push([start, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  for (const [start, end] of intervals) {
    if (start > covered + tolerance) return [covered / length, start / length];
    covered = Math.max(covered, end);
  }
  return covered < length - tolerance ? [covered / length, 1] : null;
}

/** 仅检查外墙覆盖，不将开放功能分区的边界强制解释为实体隔墙。 */
export function validateLayoutCompleteness(model: SpaceModel, requireFullCoverage = false): string[] {
  if (polygonGeometryError(model.floor.boundary)) return [];
  const errors: string[] = [];
  const unitScale = model.model.units === 'mm' ? 1000 : 1;
  const floor = closePolygon(model.floor.boundary, 0);
  for (let i = 0; i + 1 < floor.length; i++) {
    const from = floor[i];
    const to = floor[i + 1];
    const gap = uncoveredWallInterval(from, to, model.walls, 0.002 * unitScale);
    if (gap) {
      const point = (t: number) => from.map((n, axis) => Number((n + (to[axis] - n) * t).toFixed(3)));
      errors.push(`外轮廓缺墙：${JSON.stringify(point(gap[0]))}→${JSON.stringify(point(gap[1]))}，补墙中心线（允许多段共线墙覆盖）`);
    }
  }

  if (requireFullCoverage && model.spaces.every((space) => !polygonGeometryError(space.boundary))) {
    const remaining = uncoveredFloorRegions(model);
    const area = remaining.reduce((sum, polygon) => sum + polygonArea(polygon[0])
      - polygon.slice(1).reduce((holes, ring) => holes + polygonArea(ring), 0), 0) / unitScale ** 2;
    // 忽略布尔运算噪声，1 cm² 以上的实际漏区需要反馈。
    if (area > 0.0001) {
      const first = remaining.find((polygon) => polygonArea(polygon[0]) > 0)?.[0];
      errors.push(`轮廓内仍有 ${area.toFixed(4)} m² 未分配区域；如边界 ${JSON.stringify(first?.slice(0, 8))}。补为功能区、交通区或明确的预留区，不得用重叠空间抵消。`);
    }
  }
  return errors;
}
