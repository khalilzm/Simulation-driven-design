import type { Vec2, Wall } from '@sdd/shared';

export interface ExteriorWallSegment {
  id: string;
  length: number;
  p0: Vec2;
  p1: Vec2;
}

export function wallPolylineLength(points: Vec2[]): number {
  let len = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    len += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return len;
}

export function wallSegmentDirection(points: Vec2[]): { ux: number; uy: number; len: number } | null {
  if (points.length < 2) return null;
  const p0 = points[0];
  const p1 = points[points.length - 1];
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (len < 1e-9) return null;
  return { ux: (p1[0] - p0[0]) / len, uy: (p1[1] - p0[1]) / len, len };
}

/** 外轮廓每条边对应的墙段元信息（与 wall-ext-i 一致） */
export function exteriorWallSegmentsFromBoundary(boundary: Vec2[]): ExteriorWallSegment[] {
  const segments: ExteriorWallSegment[] = [];
  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    const p0 = boundary[i];
    const p1 = boundary[(i + 1) % n];
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (length < 1e-9) continue;
    segments.push({ id: `wall-ext-${segments.length + 1}`, length, p0, p1 });
  }
  return segments;
}

/** 沿 boundary 顶点顺序为每条边生成 fixed 外墙，id 为 wall-ext-1、wall-ext-2… */
export function exteriorWallsFromBoundary(
  boundary: Vec2[],
  height = 3,
  thickness = 0.2,
): Wall[] {
  const walls: Wall[] = [];
  const n = boundary.length;
  for (let i = 0; i < n; i++) {
    const p1 = boundary[i];
    const p2 = boundary[(i + 1) % n];
    if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) < 1e-9) continue;
    walls.push({
      id: `wall-ext-${walls.length + 1}`,
      geometry: { type: 'polyline', points: [p1, p2] },
      thickness,
      height,
      fixed: true,
    });
  }
  return walls;
}
