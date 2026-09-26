import {
  centerlineWallPolygon,
  polygonGeometryError,
  resolveSpaceStyle,
  wallSolidPolylines,
  type SpaceModel,
  type SunlightResult,
} from '@sdd/shared';
import { hoursToSunlightColor, resolveSunlightColorScale } from './sunlightColor';
import { triangulatePolygonEarcut, type IndexedPolygonMesh } from './polygonMesh';

/** 墙体填充（深灰 CAD 风格） */
const WALL_FILL_COLOR = 0x666666;

export interface LineGroup {
  positions: number[];
  color: number;
}

export interface PolygonFill {
  spaceId?: string;
  /** 同空间多片填充时须唯一，避免 viewport 组件互相覆盖 */
  meshId?: string;
  mesh: IndexedPolygonMesh;
  color: number;
  opacity: number;
}

function pushSeg(arr: number[], p0: [number, number], p1: [number, number], z = 0): void {
  arr.push(p0[0], p0[1], z, p1[0], p1[1], z);
}

function pushPolygon(arr: number[], pts: [number, number][]): void {
  if (pts.length < 3) return;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const coincident = Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9;
  const n = coincident ? pts.length - 1 : pts.length;
  for (let i = 0; i < n; i++) pushSeg(arr, pts[i], pts[(i + 1) % n]);
}

/** 1/4 圆弧（门开启轨迹）：圆心 (cx,cy)，从 v 方向到 u 方向，多段线逼近 */
function pushArc(
  arr: number[],
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  vx: number,
  vy: number,
  radius: number,
): void {
  const seg = 12;
  let px = cx + vx * radius;
  let py = cy + vy * radius;
  for (let i = 1; i <= seg; i++) {
    const a = (i / seg) * (Math.PI / 2);
    const x = cx + vx * radius * Math.cos(a) + ux * radius * Math.sin(a);
    const y = cy + vy * radius * Math.cos(a) + uy * radius * Math.sin(a);
    pushSeg(arr, [px, py], [x, y]);
    px = x;
    py = y;
  }
}

/** 楼层与房间的填充多边形（忠实渲染 Agent 输出，仅跳过无法三角化的非法环） */
export function modelToSpaceFills(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  const floorMesh = triangulatePolygonEarcut(model.floor.boundary, 0.01);
  if (floorMesh) {
    fills.push({ mesh: floorMesh, color: 0x9a8f7d, opacity: 0.15 });
  }
  model.spaces.forEach((s, i) => {
    if (polygonGeometryError(s.boundary)) return;
    const mesh = triangulatePolygonEarcut(s.boundary, 0.02 + i * 0.0001);
    if (!mesh) return;
    const style = resolveSpaceStyle(s, model.spaceTypes, i);
    fills.push({
      spaceId: s.id,
      mesh,
      color: style.fillColor,
      opacity: style.fillOpacity,
    });
  });
  return fills;
}

/** 日照模式：按空间 meanHours 着色（房间级伪彩） */
export function modelToSunlightSpaceFills(model: SpaceModel, result: SunlightResult): PolygonFill[] {
  const scale = resolveSunlightColorScale(result);
  const bySpace = new Map(result.spaces.map((s) => [s.spaceId, s]));
  const fills: PolygonFill[] = [];
  const floorMesh = triangulatePolygonEarcut(model.floor.boundary, 0.01);
  if (floorMesh) {
    fills.push({ mesh: floorMesh, color: 0x9a8f7d, opacity: 0.08 });
  }
  model.spaces.forEach((s, i) => {
    if (polygonGeometryError(s.boundary)) return;
    const mesh = triangulatePolygonEarcut(s.boundary, 0.02 + i * 0.0001);
    if (!mesh) return;
    const metrics = bySpace.get(s.id);
    const hours = metrics?.meanHours ?? 0;
    fills.push({
      spaceId: s.id,
      mesh,
      color: hoursToSunlightColor(hours, scale),
      opacity: 0.72,
    });
  });
  return fills;
}

function closeRing(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return pts;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) return pts;
  return [...pts, first];
}

/** 由墙中线 + 厚度生成填充 Mesh（z 略高于功能区，便于压盖半透明底图） */
export function modelToWallFills(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  model.walls.forEach((w, i) => {
    const pts = w.geometry.points;
    if (pts.length < 2 || w.thickness <= 0) return;
    for (const line of wallSolidPolylines(w, model.openings)) {
      const outline = centerlineWallPolygon(line, w.thickness);
      if (!outline || outline.length < 3) continue;
      const mesh = triangulatePolygonEarcut(closeRing(outline), 0.045 + i * 0.00001);
      if (mesh) fills.push({ mesh, color: WALL_FILL_COLOR, opacity: 1 });
    }
  });
  return fills;
}

/** 把空间模型展开为按颜色分组的扁平线段数组（z=0）。 */
export function modelToLineGroups(model: SpaceModel): LineGroup[] {
  const groups: LineGroup[] = [];
  const add = (color: number): number[] => {
    const positions: number[] = [];
    groups.push({ positions, color });
    return positions;
  };

  const floor = add(0x9a8f7d);
  pushPolygon(floor, model.floor.boundary);

  for (let i = 0; i < model.spaces.length; i++) {
    const s = model.spaces[i];
    // 新布局由实际墙体表达围合，功能色块不再叠加闭合描边或跨过门洞。
    if (s.enclosed !== undefined) continue;
    const style = resolveSpaceStyle(s, model.spaceTypes, i);
    const border = add(style.borderColor);
    pushPolygon(border, s.boundary);
  }

  const openings = add(0x1f7a8c);
  for (const o of model.openings) {
    const wall = model.walls.find((w) => w.id === o.hostWallId);
    if (!wall || wall.geometry.points.length < 2) continue;
    const pts = wall.geometry.points;
    let acc = 0;
    let mx = pts[0][0];
    let my = pts[0][1];
    let ux = 1;
    let uy = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      if (acc + segLen >= o.position - 1e-9) {
        const t = segLen > 0 ? (o.position - acc) / segLen : 0;
        mx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
        my = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
        ux = (pts[i + 1][0] - pts[i][0]) / (segLen || 1);
        uy = (pts[i + 1][1] - pts[i][1]) / (segLen || 1);
        break;
      }
      acc += segLen;
    }
    const isWindow = model.windows.some((w) => w.openingId === o.id);
    if (isWindow) {
      pushSeg(openings, [mx - ux * o.width / 2, my - uy * o.width / 2], [mx + ux * o.width / 2, my + uy * o.width / 2]);
      continue;
    }
    const door = model.doors.find((d) => d.openingId === o.id);
    const vx = -uy;
    const vy = ux;
    const r = door?.leafCount === 2 ? o.width / 2 : o.width;
    const ax = mx - ux * o.width / 2;
    const ay = my - uy * o.width / 2;
    if (!door || door.swing === 'none') {
      for (const sign of [-1, 1]) {
        const x = mx + ux * o.width / 2 * sign, y = my + uy * o.width / 2 * sign;
        pushSeg(openings, [x - vx * wall.thickness / 2, y - vy * wall.thickness / 2], [x + vx * wall.thickness / 2, y + vy * wall.thickness / 2]);
      }
      continue;
    }
    if (door?.leafCount === 2) {
      const ex = mx + ux * r;
      const ey = my + uy * r;
      const b1x = ax + vx * r;
      const b1y = ay + vy * r;
      const b2x = ex + vx * r;
      const b2y = ey + vy * r;
      pushSeg(openings, [ax, ay], [b1x, b1y]);
      pushSeg(openings, [ex, ey], [b2x, b2y]);
      pushArc(openings, ax, ay, ux, uy, vx, vy, r);
      pushArc(openings, ex, ey, -ux, -uy, -vx, -vy, r);
    } else {
      const bx = ax + vx * r;
      const by = ay + vy * r;
      pushSeg(openings, [ax, ay], [bx, by]);
      pushArc(openings, ax, ay, ux, uy, vx, vy, r);
    }
  }

  return groups;
}
