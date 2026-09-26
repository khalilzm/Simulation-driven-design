import type { Vec2 } from './model';

const MITER_LIMIT = 4;

function perpOffset(dx: number, dy: number, half: number): Vec2 {
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return [0, 0];
  return [(-dy / len) * half, (dx / len) * half];
}

function intersectLines(p: Vec2, d1: Vec2, q: Vec2, d2: Vec2): Vec2 | null {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-12) return null;
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const t = (rx * d2[1] - ry * d2[0]) / cross;
  return [p[0] + t * d1[0], p[1] + t * d1[1]];
}

function jointOffset(
  p: Vec2,
  dIn: Vec2,
  dOut: Vec2,
  half: number,
  sign: 1 | -1,
): Vec2 {
  const nIn = perpOffset(dIn[0], dIn[1], half * sign);
  const nOut = perpOffset(dOut[0], dOut[1], half * sign);
  const pIn: Vec2 = [p[0] + nIn[0], p[1] + nIn[1]];
  const pOut: Vec2 = [p[0] + nOut[0], p[1] + nOut[1]];
  const hit = intersectLines(pIn, dIn, pOut, dOut);
  if (hit && Math.hypot(hit[0] - p[0], hit[1] - p[1]) <= half * MITER_LIMIT) {
    return hit;
  }
  return [(p[0] + (nIn[0] + nOut[0]) / 2), (p[1] + (nIn[1] + nOut[1]) / 2)];
}

/**
 * 由墙体中心线折线与厚度构造闭合填充多边形（左右偏移 + 转角 miter）。
 * points 为墙中线顶点序列，thickness 为全厚（米）。
 */
export function centerlineWallPolygon(points: Vec2[], thickness: number): Vec2[] | null {
  if (points.length < 2 || !Number.isFinite(thickness) || thickness <= 0) return null;

  const half = thickness / 2;
  const n = points.length;
  const left: Vec2[] = [];
  const right: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    let dIn: Vec2;
    let dOut: Vec2;

    if (i === 0) {
      dIn = dOut = [points[1][0] - points[0][0], points[1][1] - points[0][1]];
    } else if (i === n - 1) {
      dIn = dOut = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]];
    } else {
      dIn = [points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]];
      dOut = [points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]];
    }

    if (i === 0 || i === n - 1) {
      const nVec = perpOffset(dOut[0], dOut[1], half);
      left.push([points[i][0] + nVec[0], points[i][1] + nVec[1]]);
      right.push([points[i][0] - nVec[0], points[i][1] - nVec[1]]);
    } else {
      left.push(jointOffset(points[i], dIn, dOut, half, 1));
      right.push(jointOffset(points[i], dIn, dOut, half, -1));
    }
  }

  return [...left, ...right.reverse()];
}

/** 矩形墙段面积（用于测试与校验） */
export function wallStripArea(points: Vec2[], thickness: number): number {
  const poly = centerlineWallPolygon(points, thickness);
  if (!poly || poly.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    area += x0 * y1 - x1 * y0;
  }
  return Math.abs(area / 2);
}
