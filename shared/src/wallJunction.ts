import type { Vec2, Wall } from './model';
import { intersectLines, jointOffset, perpOffset } from './wallStrip';

export interface WallEndTrim {
  kind: 'butt' | 'miter' | 'flush';
  /** miter（角接）：邻墙在接头点朝邻墙体内的方向。 */
  neighborBodyDir?: Vec2;
  /** flush（T 接）：沿墙轴向墙体内回退到主墙外表面的距离（主墙半厚）。 */
  retreat?: number;
}

const TOL = 1e-3;

function unit(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1]);
  return len < 1e-12 ? [0, 0] : [v[0] / len, v[1] / len];
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function onInterior(p: Vec2, pts: Vec2[], tol: number): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (distToSegment(p, pts[i], pts[i + 1]) < tol) return true;
  }
  return false;
}

function collinear(a: Vec2, b: Vec2): boolean {
  const cross = Math.abs(a[0] * b[1] - a[1] * b[0]);
  return cross < 1e-9 * Math.max(Math.hypot(a[0], a[1]), Math.hypot(b[0], b[1]), 1);
}

function trimAt(wall: Wall, p: Vec2, toward: Vec2, walls: Wall[]): WallEndTrim {
  // dWall 指向接头点（从相邻点 toward 指向端点 p）。
  const dWall: Vec2 = [p[0] - toward[0], p[1] - toward[1]];
  // 1. 角接：另一面墙的端点落在 p 处。
  for (const other of walls) {
    if (other.id === wall.id) continue;
    const op = other.geometry.points;
    if (op.length < 2) continue;
    const oStart = op[0];
    if (Math.hypot(oStart[0] - p[0], oStart[1] - p[1]) < TOL) {
      const nb: Vec2 = [op[1][0] - op[0][0], op[1][1] - op[0][1]];
      return collinear(dWall, nb) ? { kind: 'butt' } : { kind: 'miter', neighborBodyDir: nb };
    }
    const oEnd = op[op.length - 1];
    if (Math.hypot(oEnd[0] - p[0], oEnd[1] - p[1]) < TOL) {
      const nb: Vec2 = [op[op.length - 2][0] - oEnd[0], op[op.length - 2][1] - oEnd[1]];
      return collinear(dWall, nb) ? { kind: 'butt' } : { kind: 'miter', neighborBodyDir: nb };
    }
  }
  // 2. T 接：p 落在另一面墙的内部。
  for (const other of walls) {
    if (other.id === wall.id) continue;
    if (onInterior(p, other.geometry.points, TOL)) {
      return { kind: 'flush', retreat: other.thickness / 2 };
    }
  }
  return { kind: 'butt' };
}

/** 判断 wall 两端点在所有墙里的接头类型。 */
export function wallEndTrims(wall: Wall, walls: Wall[]): { start: WallEndTrim; end: WallEndTrim } {
  const pts = wall.geometry.points;
  if (pts.length < 2) return { start: { kind: 'butt' }, end: { kind: 'butt' } };
  const start = trimAt(wall, pts[0], pts[1], walls);
  const end = trimAt(wall, pts[pts.length - 1], pts[pts.length - 2], walls);
  return { start, end };
}

function endpointOffsets(p: Vec2, travel: Vec2, intoBody: Vec2, half: number, trim: WallEndTrim): { left: Vec2; right: Vec2 } {
  if (trim.kind === 'miter' && trim.neighborBodyDir) {
    return miterOffsets(p, travel, intoBody, trim.neighborBodyDir, half);
  }
  if (trim.kind === 'flush' && trim.retreat) {
    // 沿墙轴向墙体内回退 retreat，再做垂直平切（贴主墙外表面）。
    const q: Vec2 = [p[0] + intoBody[0] * trim.retreat, p[1] + intoBody[1] * trim.retreat];
    const n = perpOffset(travel[0], travel[1], half);
    return { left: [q[0] + n[0], q[1] + n[1]], right: [q[0] - n[0], q[1] - n[1]] };
  }
  const n = perpOffset(travel[0], travel[1], half);
  return { left: [p[0] + n[0], p[1] + n[1]], right: [p[0] - n[0], p[1] - n[1]] };
}

/** 角接 miter：墙两端偏移线与两墙体内夹的角平分线求交，得到外角/内角顶点。 */
function miterOffsets(p: Vec2, travel: Vec2, bodyDir: Vec2, neighborBodyDir: Vec2, half: number): { left: Vec2; right: Vec2 } {
  const n = perpOffset(travel[0], travel[1], half);
  const bW = unit(bodyDir);
  const bN = unit(neighborBodyDir);
  const bisect = unit([bW[0] + bN[0], bW[1] + bN[1]]);
  if (Math.hypot(bisect[0], bisect[1]) < 1e-9) {
    return { left: [p[0] + n[0], p[1] + n[1]], right: [p[0] - n[0], p[1] - n[1]] };
  }
  const left = intersectLines([p[0] + n[0], p[1] + n[1]], travel, p, bisect);
  const right = intersectLines([p[0] - n[0], p[1] - n[1]], travel, p, bisect);
  if (!left || !right) {
    return { left: [p[0] + n[0], p[1] + n[1]], right: [p[0] - n[0], p[1] - n[1]] };
  }
  return { left, right };
}

/** 由墙中心线 + 厚度 + 两端接头裁剪构造闭合条带多边形。 */
export function wallStripPolygon(
  points: Vec2[],
  thickness: number,
  start: WallEndTrim,
  end: WallEndTrim,
): Vec2[] | null {
  if (points.length < 2 || !Number.isFinite(thickness) || thickness <= 0) return null;
  const half = thickness / 2;
  const n = points.length;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      const travel: Vec2 = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
      const o = endpointOffsets(points[0], travel, unit(travel), half, start);
      left.push(o.left);
      right.push(o.right);
    } else if (i === n - 1) {
      const travel: Vec2 = [points[n - 1][0] - points[n - 2][0], points[n - 1][1] - points[n - 2][1]];
      const o = endpointOffsets(points[n - 1], travel, unit([-travel[0], -travel[1]]), half, end);
      left.push(o.left);
      right.push(o.right);
    } else {
      const dIn: Vec2 = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]];
      const dOut: Vec2 = [points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]];
      left.push(jointOffset(points[i], dIn, dOut, half, 1));
      right.push(jointOffset(points[i], dIn, dOut, half, -1));
    }
  }
  return [...left, ...right.reverse()];
}

/** 逐墙裁剪：返回每面墙在接头处裁剪后的闭合条带多边形（不含洞口）。 */
export function resolveWallJunctions(walls: Wall[]): Map<string, Vec2[]> {
  const out = new Map<string, Vec2[]>();
  for (const w of walls) {
    const trims = wallEndTrims(w, walls);
    const poly = wallStripPolygon(w.geometry.points, w.thickness, trims.start, trims.end);
    if (poly) out.set(w.id, poly);
  }
  return out;
}
