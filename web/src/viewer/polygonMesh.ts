import earcut, { deviation } from 'earcut';
import { polygonGeometryError } from '@sdd/shared';

/** 去掉首尾重合点，得到开环顶点 */
export function ringVertices(pts: [number, number][]): [number, number][] {
  if (pts.length < 3) return [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) {
    return pts.slice(0, -1);
  }
  return pts;
}

export interface IndexedPolygonMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** 用 earcut 将闭合多边形三角剖分，输出 GMesh 所需的 positions + indices */
export function triangulatePolygonEarcut(
  pts: [number, number][],
  z = 0.02,
): IndexedPolygonMesh | null {
  if (polygonGeometryError(pts) || !Number.isFinite(z)) return null;
  const ring = ringVertices(pts);
  if (ring.length < 3) return null;

  const flat: number[] = [];
  for (const [x, y] of ring) flat.push(x, y);

  const triIndices = earcut(flat);
  const areaDeviation = deviation(flat, [], 2, triIndices);
  if (!triIndices.length || !Number.isFinite(areaDeviation) || areaDeviation > 1e-8) return null;

  const positions = new Float32Array(ring.length * 3);
  for (let i = 0; i < ring.length; i++) {
    positions[i * 3] = ring[i][0];
    positions[i * 3 + 1] = ring[i][1];
    positions[i * 3 + 2] = z;
  }

  return { positions, indices: new Uint32Array(triIndices) };
}

function triangleMesh(pts: [number, number][], z: number): IndexedPolygonMesh {
  const positions = new Float32Array(9);
  for (let i = 0; i < 3; i++) {
    positions[i * 3] = pts[i][0];
    positions[i * 3 + 1] = pts[i][1];
    positions[i * 3 + 2] = z;
  }
  return { positions, indices: new Uint32Array([0, 1, 2]) };
}

/** Honeybee 传感器面：三角或任意平面多边形（无需重复闭合点） */
export function meshFromPlanarFace(pts: [number, number][], z = 0.02): IndexedPolygonMesh | null {
  if (pts.length < 3 || !Number.isFinite(z)) return null;
  if (pts.length === 3) return triangleMesh(pts, z);
  const closed: [number, number][] = [...pts, pts[0]];
  return triangulatePolygonEarcut(closed, z);
}

function ringSignedArea(ring: [number, number][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return area / 2;
}

/** 将平面闭合多边形沿 Z 挤出为实体（顶底盖 + 侧面） */
export function extrudePolygonPrism(
  pts: [number, number][],
  z0: number,
  z1: number,
): IndexedPolygonMesh | null {
  if (!Number.isFinite(z0) || !Number.isFinite(z1) || z1 <= z0 + 1e-9) return null;
  if (polygonGeometryError(pts)) return null;
  let ring = ringVertices(pts);
  if (ring.length < 3) return null;
  // 统一为 CCW：earcut 输出顶盖本身按 CCW，但侧面用原始顶点序；
  // 若输入是 CW（如 centerlineWallPolygon），侧面法线会朝内、与顶盖相反，
  // 导致实体同一网格内外法线不一致（3D 下墙体像被切成两半）。
  if (ringSignedArea(ring) < 0) ring = ring.slice().reverse();

  const flat: number[] = [];
  for (const [x, y] of ring) flat.push(x, y);
  const cap = earcut(flat);
  const areaDeviation = deviation(flat, [], 2, cap);
  if (!cap.length || !Number.isFinite(areaDeviation) || areaDeviation > 1e-8) return null;

  const n = ring.length;
  const positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = ring[i][0];
    positions[i * 3 + 1] = ring[i][1];
    positions[i * 3 + 2] = z0;
    positions[(n + i) * 3] = ring[i][0];
    positions[(n + i) * 3 + 1] = ring[i][1];
    positions[(n + i) * 3 + 2] = z1;
  }

  const indices: number[] = [];
  for (let i = 0; i < cap.length; i += 3) {
    indices.push(cap[i] + n, cap[i + 1] + n, cap[i + 2] + n);
  }
  for (let i = 0; i < cap.length; i += 3) {
    indices.push(cap[i + 2], cap[i + 1], cap[i]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const bi = i;
    const bj = j;
    const ti = n + i;
    const tj = n + j;
    indices.push(bi, bj, tj, bi, tj, ti);
  }

  return { positions, indices: new Uint32Array(indices) };
}
