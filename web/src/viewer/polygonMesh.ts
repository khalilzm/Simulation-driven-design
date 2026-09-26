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
