import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../geometry/polygon';
import { floorCornerVertices, floorEdgeSegments } from './layoutContext';

export interface FloorEdgeInfo {
  id: string;
  index: number;
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  length: number;
  start: Vec2;
  end: Vec2;
}

export interface FloorCornerInfo {
  id: string;
  index: number;
  point: Vec2;
}

export interface NamedEdgePoint {
  id: string;
  edge: number;
  t: number;
}

export interface FloorPlanTopology {
  corners: FloorCornerInfo[];
  edges: FloorEdgeInfo[];
  namedPoints: Map<string, NamedEdgePoint>;
}

export function buildFloorPlanTopology(floorBoundary: Vec2[], named: NamedEdgePoint[] = []): FloorPlanTopology {
  const ring = closePolygon(floorBoundary, 0);
  const cornerPts = floorCornerVertices(ring);
  const segments = floorEdgeSegments(ring);
  const corners: FloorCornerInfo[] = cornerPts.map((point, index) => ({
    id: `V${index}`,
    index,
    point: [point[0], point[1]],
  }));
  const edges: FloorEdgeInfo[] = segments.map(([start, end], index) => {
    const fromIndex = index;
    const toIndex = (index + 1) % corners.length;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    return {
      id: `E${index}`,
      index,
      from: `V${fromIndex}`,
      to: `V${toIndex}`,
      fromIndex,
      toIndex,
      length,
      start: [start[0], start[1]],
      end: [end[0], end[1]],
    };
  });
  const namedPoints = new Map<string, NamedEdgePoint>();
  for (const item of named) namedPoints.set(item.id, item);
  return { corners, edges, namedPoints };
}

export function floorTopologyForPrompt(floorBoundary: Vec2[]): object {
  const topo = buildFloorPlanTopology(floorBoundary);
  return {
    corners: topo.corners.map((c) => ({ id: c.id, point: c.point })),
    edges: topo.edges.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      length: Number(e.length.toFixed(4)),
    })),
  };
}

function parseCornerRef(raw: string): number | null {
  const m = /^V(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]);
}

export function resolvePlanRef(
  ref: unknown,
  topo: FloorPlanTopology,
  field: string,
): Vec2 {
  if (typeof ref === 'string') {
    const corner = parseCornerRef(ref);
    if (corner !== null) {
      const c = topo.corners[corner];
      if (!c) throw new Error(`${field} 引用 ${ref} 超出角点范围（0～${topo.corners.length - 1}）`);
      return [c.point[0], c.point[1]];
    }
    const named = topo.namedPoints.get(ref);
    if (named) return pointOnEdge(topo, named.edge, named.t, `${field} 顶点 ${ref}`);
    throw new Error(`${field} 无法解析引用 "${ref}"；使用 V0…Vn 或 vertices 中的 id`);
  }
  if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
    const item = ref as Record<string, unknown>;
    if (item.corner !== undefined) {
      const index = item.corner;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= topo.corners.length) {
        throw new Error(`${field}.corner 无效`);
      }
      return [...topo.corners[index].point];
    }
    if (item.edge !== undefined) {
      const edge = item.edge;
      const t = item.t;
      if (typeof edge !== 'number' || typeof t !== 'number') throw new Error(`${field} 需要 edge 与 t`);
      return pointOnEdge(topo, edge, t, field);
    }
  }
  throw new Error(`${field} 必须是角点引用 Vn、vertices.id 或 { corner | edge, t }`);
}

export function pointOnEdge(topo: FloorPlanTopology, edgeIndex: number, t: number, field: string): Vec2 {
  const edge = topo.edges[edgeIndex];
  if (!edge) throw new Error(`${field} 边索引 ${edgeIndex} 无效（0～${topo.edges.length - 1}）`);
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new Error(`${field} 参数 t 须在 0～1`);
  return [
    edge.start[0] + (edge.end[0] - edge.start[0]) * t,
    edge.start[1] + (edge.end[1] - edge.start[1]) * t,
  ];
}

export function parseNamedVertices(raw: unknown, topo: FloorPlanTopology): NamedEdgePoint[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('vertices 必须是数组');
  const out: NamedEdgePoint[] = [];
  const ids = new Set<string>();
  for (const rawVertex of raw) {
    if (!rawVertex || typeof rawVertex !== 'object') throw new Error('vertices 项必须是对象');
    const item = rawVertex as Record<string, unknown>;
    if (typeof item.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(item.id)) {
      throw new Error('vertices.id 须为字母开头的标识');
    }
    if (ids.has(item.id)) throw new Error(`vertices id 重复：${item.id}`);
    if (parseCornerRef(item.id) !== null) throw new Error(`vertices.id 不得使用 Vn 形式：${item.id}`);
    ids.add(item.id);
    const edge = item.edge;
    const t = item.t;
    if (typeof edge !== 'number' || !Number.isInteger(edge)) throw new Error(`${item.id}.edge 必须是整数边索引`);
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`${item.id}.t 必须是 0～1 的参数`);
    pointOnEdge(topo, edge, t, item.id);
    out.push({ id: item.id, edge, t });
  }
  return out;
}
