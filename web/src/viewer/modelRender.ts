import {
  centerlineWallPolygon,
  polygonGeometryError,
  resolveSpaceStyle,
  wallSolidPolylines,
  wallSolidPrisms,
  type Opening,
  type SpaceModel,
  type SunlightResult,
  type Wall,
} from '@sdd/shared';
import { hoursToSunlightColor, resolveSunlightColorScale } from './sunlightColor';
import { extrudePolygonPrism, triangulatePolygonEarcut, type IndexedPolygonMesh } from './polygonMesh';

/** 平面墙体填充（#8e8e8e） */
const WALL_FILL_COLOR_2D = 0x8e8e8e;
/** 3D 墙体（#e8e8e8） */
const WALL_FILL_COLOR_3D = 0xDDDDDD;

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
      if (mesh) fills.push({ mesh, color: WALL_FILL_COLOR_2D, opacity: 1 });
    }
  });
  return fills;
}

/** 一段墙的 3D 盒子网格（8 顶点 + 12 三角形，用于门扇/玻璃）。 */
function wallBoxMesh(
  a: [number, number],
  b: [number, number],
  thickness: number,
  z0: number,
  z1: number,
): IndexedPolygonMesh | null {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const len = Math.hypot(ux, uy);
  if (len < 1e-9) return null;
  const dx = ux / len;
  const dy = uy / len;
  const nx = -dy;
  const ny = dx;
  const h = thickness / 2;
  // 逆时针顶点序，保证顶/底/侧面法线统一朝外。
  const cx: [number, number][] = [
    [a[0] - nx * h, a[1] - ny * h],
    [b[0] - nx * h, b[1] - ny * h],
    [b[0] + nx * h, b[1] + ny * h],
    [a[0] + nx * h, a[1] + ny * h],
  ];
  const positions = new Float32Array(24);
  for (let i = 0; i < 4; i++) {
    positions[i * 3] = cx[i][0];
    positions[i * 3 + 1] = cx[i][1];
    positions[i * 3 + 2] = z0;
    positions[(i + 4) * 3] = cx[i][0];
    positions[(i + 4) * 3 + 1] = cx[i][1];
    positions[(i + 4) * 3 + 2] = z1;
  }
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  return { positions, indices };
}

/** 门/窗框件：中心 (cx,cy)，沿墙方向 u 宽 alongU，进深 depth（法向），高度 z0..z1。 */
function frameBox(
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  alongU: number,
  depth: number,
  z0: number,
  z1: number,
): IndexedPolygonMesh | null {
  return wallBoxMesh(
    [cx - ux * alongU / 2, cy - uy * alongU / 2],
    [cx + ux * alongU / 2, cy + uy * alongU / 2],
    depth,
    z0,
    z1,
  );
}

/** 3D 墙体：中线条带 + miter 轮廓，按门/窗真实高度在 (弧长 × 高度) 平面做布尔减后分段挤出。 */
export function modelToWallBoxes3D(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  model.walls.forEach((wall, wi) => {
    const pts = wall.geometry.points;
    if (pts.length < 2 || wall.thickness <= 0) return;
    let bi = 0;
    for (const prism of wallSolidPrisms(wall, model.openings)) {
      const outline = centerlineWallPolygon(prism.points, wall.thickness);
      if (!outline || outline.length < 3) continue;
      const mesh = extrudePolygonPrism(closeRing(outline), prism.z0, prism.z1);
      if (!mesh) continue;
      fills.push({
        mesh,
        color: WALL_FILL_COLOR_3D,
        opacity: 1,
        meshId: `wall3d-${wi}-${bi++}`,
      });
    }
  });
  return fills;
}

const DOOR_THICKNESS = 0.04;
const GLASS_THICKNESS = 0.01;
const DOOR_COLOR = 0x9a6b4f;
const GLASS_COLOR = 0xaad4e8;
/** 门框/窗框的可见边框宽度（沿墙方向 / 沿高度方向） */
const FRAME_THICKNESS = 0.06;
/** 框件突出墙面之外的单侧厚度 */
const FRAME_PROUD = 0.01;
const DOOR_FRAME_COLOR = 0x5c3a24;
const WINDOW_FRAME_COLOR = 0xe6e2d8;

/** 门扇 + 门框（左右竖框 + 上槛）。 */
export function modelToDoorMeshes3D(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  model.doors.forEach((door, i) => {
    const opening = model.openings.find((o) => o.id === door.openingId);
    if (!opening) return;
    const wall = model.walls.find((w) => w.id === opening.hostWallId);
    if (!wall) return;
    const loc = openingLocation(wall, opening.position);
    if (!loc) return;
    const { mx, my, ux, uy } = loc;
    const w = opening.width;
    const h = opening.height;
    const depth = wall.thickness + FRAME_PROUD * 2;
    const add = (mesh: IndexedPolygonMesh | null, color: number, id: string) => {
      if (mesh) fills.push({ mesh, color, opacity: 1, meshId: id });
    };
    // 门扇
    add(wallBoxMesh(
      [mx - ux * w / 2, my - uy * w / 2],
      [mx + ux * w / 2, my + uy * w / 2],
      DOOR_THICKNESS, 0, h,
    ), DOOR_COLOR, `door3d-${i}`);
    // 左右竖框
    add(frameBox(mx - ux * w / 2, my - uy * w / 2, ux, uy, FRAME_THICKNESS, depth, 0, h), DOOR_FRAME_COLOR, `door3d-frame-l-${i}`);
    add(frameBox(mx + ux * w / 2, my + uy * w / 2, ux, uy, FRAME_THICKNESS, depth, 0, h), DOOR_FRAME_COLOR, `door3d-frame-r-${i}`);
    // 上槛
    add(frameBox(mx, my, ux, uy, w + FRAME_THICKNESS, depth, h, h + FRAME_THICKNESS), DOOR_FRAME_COLOR, `door3d-frame-t-${i}`);
  });
  return fills;
}

/** 窗玻璃 + 窗框（左右竖框 + 上下横框）。 */
export function modelToWindowMeshes3D(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  model.windows.forEach((win, i) => {
    const opening = model.openings.find((o) => o.id === win.openingId);
    if (!opening) return;
    const wall = model.walls.find((w) => w.id === opening.hostWallId);
    if (!wall) return;
    const loc = openingLocation(wall, opening.position);
    if (!loc) return;
    const { mx, my, ux, uy } = loc;
    const w = opening.width;
    const sill = opening.sillHeight ?? 0;
    const h = opening.height;
    const depth = wall.thickness + FRAME_PROUD * 2;
    const add = (mesh: IndexedPolygonMesh | null, color: number, id: string, opacity = 1) => {
      if (mesh) fills.push({ mesh, color, opacity, meshId: id });
    };
    // 玻璃（半透明）
    add(wallBoxMesh(
      [mx - ux * w / 2, my - uy * w / 2],
      [mx + ux * w / 2, my + uy * w / 2],
      GLASS_THICKNESS, sill, sill + h,
    ), GLASS_COLOR, `window3d-glass-${i}`, 0.5);
    // 左右竖框
    add(frameBox(mx - ux * w / 2, my - uy * w / 2, ux, uy, FRAME_THICKNESS, depth, sill, sill + h), WINDOW_FRAME_COLOR, `window3d-frame-l-${i}`);
    add(frameBox(mx + ux * w / 2, my + uy * w / 2, ux, uy, FRAME_THICKNESS, depth, sill, sill + h), WINDOW_FRAME_COLOR, `window3d-frame-r-${i}`);
    // 上下横框
    add(frameBox(mx, my, ux, uy, w + FRAME_THICKNESS, depth, sill - FRAME_THICKNESS, sill), WINDOW_FRAME_COLOR, `window3d-frame-b-${i}`);
    add(frameBox(mx, my, ux, uy, w + FRAME_THICKNESS, depth, sill + h, sill + h + FRAME_THICKNESS), WINDOW_FRAME_COLOR, `window3d-frame-t-${i}`);
  });
  return fills;
}

/** 洞口中心点与墙方向（沿 hostWall 弧长定位）。 */
function openingLocation(wall: Wall, position: number): { mx: number; my: number; ux: number; uy: number } | null {
  const pts = wall.geometry.points;
  if (pts.length < 2) return null;
  let acc = 0;
  let mx = pts[0][0];
  let my = pts[0][1];
  let ux = 1;
  let uy = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const segLen = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (acc + segLen >= position - 1e-9) {
      const t = segLen > 0 ? (position - acc) / segLen : 0;
      mx = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
      my = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      ux = (pts[i + 1][0] - pts[i][0]) / (segLen || 1);
      uy = (pts[i + 1][1] - pts[i][1]) / (segLen || 1);
      break;
    }
    acc += segLen;
  }
  return { mx, my, ux, uy };
}

/** 窗户填充（白色窗框，z 高于功能区与墙体） */
export function modelToWindowFills(model: SpaceModel): PolygonFill[] {
  const fills: PolygonFill[] = [];
  model.windows.forEach((win, i) => {
    const opening = model.openings.find((o) => o.id === win.openingId);
    if (!opening) return;
    const wall = model.walls.find((w) => w.id === opening.hostWallId);
    if (!wall) return;
    const loc = openingLocation(wall, opening.position);
    if (!loc) return;
    const { mx, my, ux, uy } = loc;
    const vx = -uy;
    const vy = ux;
    const halfT = wall.thickness / 2;
    const halfW = opening.width / 2;
    const corners: [number, number][] = [
      [mx - ux * halfW + vx * halfT, my - uy * halfW + vy * halfT],
      [mx + ux * halfW + vx * halfT, my + uy * halfW + vy * halfT],
      [mx + ux * halfW - vx * halfT, my + uy * halfW - vy * halfT],
      [mx - ux * halfW - vx * halfT, my - uy * halfW - vy * halfT],
    ];
    const mesh = triangulatePolygonEarcut(closeRing(corners), 0.05 + i * 0.00001);
    if (mesh) fills.push({ mesh, color: 0xffffff, opacity: 1 });
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
      // 窗框矩形由 modelToWindowFills 白色填充渲染；中心线抬高到填充之上（z=0.06 > 0.05）
      pushSeg(openings, [mx - ux * o.width / 2, my - uy * o.width / 2], [mx + ux * o.width / 2, my + uy * o.width / 2], 0.06);
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
