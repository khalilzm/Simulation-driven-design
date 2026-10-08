import type { SpaceModel, Vec2, Wall } from '@sdd/shared';
import { pointAlongWallPolyline } from '../model/geometry';
import { segmentCoveredBy } from './layoutWalls';
import { sharedSegments } from './regionGeometry';
import { openingFacesOutside } from './layoutAccess';
import { openingRoomSides } from './residentialSolver';

export const OUTSIDE = 'outside';

export type SpatialGraphNodeKind = 'space' | 'outside';

export interface SpatialGraphNode {
  id: string;
  kind: SpatialGraphNodeKind;
  /** 物理空间 ID（outside 节点无）。 */
  spaceId?: string;
  /** 稳定逻辑功能 ID；无显式 allocationId 时回退到 spaceId。 */
  allocationId?: string;
  enclosed?: boolean;
}

export type SpatialGraphEdgeKind = 'adjacency' | 'door' | 'open' | 'window';

export interface SpatialGraphEdge {
  id: string;
  kind: SpatialGraphEdgeKind;
  from: string;
  to: string;
  /** 关联的墙 ID（adjacency/window 边）。 */
  wallId?: string;
  /** 关联的洞口 ID（door/open/window 边）。 */
  openingId?: string;
  /** 关联的门构件 ID（door 边）。 */
  doorId?: string;
  /** 净通行宽度（米），door/open 边有效。 */
  netWidthM?: number;
  /** 关联墙是否锁定（fixed/structural/curtain），影响能否修改。 */
  locked?: boolean;
}

/** 从模型派生的空间关系索引；不成为另一份手工维护的几何。 */
export interface SpatialGraph {
  nodes: SpatialGraphNode[];
  edges: SpatialGraphEdge[];
  nodeById: Record<string, SpatialGraphNode>;
  /** 仅通行边（door/open）的无向邻接表，供可达性查询。 */
  passable: Record<string, string[]>;
}

function wallLocked(wall: Wall): boolean {
  return wall.fixed || wall.role === 'structural' || wall.role === 'curtain';
}

function segmentsOfWall(points: Vec2[]): [Vec2, Vec2][] {
  const segments: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < points.length; i++) segments.push([points[i], points[i + 1]]);
  return segments;
}

/** 线段 [a,b] 两侧的空间（含 outside）。索引性质：无法完整判定时返回少于 2 个。 */
function sidesOfSegment(model: SpaceModel, a: Vec2, b: Vec2): string[] {
  const sides: string[] = [];
  for (const space of model.spaces) {
    if (segmentCoveredBy(a, b, sharedSegments(space.boundary, [a, b]))) sides.push(space.id);
  }
  if (segmentCoveredBy(a, b, sharedSegments(model.floor.boundary, [a, b]))) sides.push(OUTSIDE);
  return sides;
}

export function buildSpatialGraph(model: SpaceModel): SpatialGraph {
  const nodes: SpatialGraphNode[] = [
    ...model.spaces.map((space) => ({
      id: space.id,
      kind: 'space' as const,
      spaceId: space.id,
      allocationId: space.allocationId ?? space.id,
      enclosed: space.enclosed ?? false,
    })),
    { id: OUTSIDE, kind: 'outside' as const },
  ];
  const nodeById: Record<string, SpatialGraphNode> = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const passable: Record<string, string[]> = Object.fromEntries(nodes.map((n) => [n.id, [] as string[]]));
  const edges: SpatialGraphEdge[] = [];
  const connect = (from: string, to: string) => {
    if (from === to) return;
    if (!passable[from].includes(to)) passable[from].push(to);
    if (!passable[to].includes(from)) passable[to].push(from);
  };

  // 相邻：墙的两侧各是一个空间（中间无 outside）。
  for (const wall of model.walls) {
    const sides = new Set<string>();
    for (const [a, b] of segmentsOfWall(wall.geometry.points)) {
      for (const side of sidesOfSegment(model, a, b)) sides.add(side);
    }
    const sideArr = [...sides];
    if (sideArr.length === 2 && sideArr[0] !== OUTSIDE && sideArr[1] !== OUTSIDE) {
      edges.push({ id: `adj-${wall.id}`, kind: 'adjacency', from: sideArr[0], to: sideArr[1], wallId: wall.id, locked: wallLocked(wall) });
    }
  }

  // 门窗/开放通道：洞口两端落在两侧。
  const windowOpeningIds = new Set(model.windows.map((window) => window.openingId));
  const doorByOpening = new Map(model.doors.map((door) => [door.openingId, door]));
  const scale = model.model.units === 'mm' ? 1000 : 1;
  for (const opening of model.openings) {
    const wall = model.walls.find((item) => item.id === opening.hostWallId);
    if (!wall) continue;
    const a = pointAlongWallPolyline(wall.geometry.points, opening.position - opening.width / 2);
    const b = pointAlongWallPolyline(wall.geometry.points, opening.position + opening.width / 2);
    if (!a || !b) continue;
    const sides = sidesOfSegment(model, a, b);
    if (!sides.length) sides.push(...openingRoomSides(model, wall, opening.position, opening.width));
    if (!sides.includes(OUTSIDE) && openingFacesOutside(wall,a,b,model.floor.boundary)) sides.push(OUTSIDE);
    if (sides.length !== 2) continue;
    const locked = wallLocked(wall);
    if (windowOpeningIds.has(opening.id)) {
      edges.push({ id: `win-${opening.id}`, kind: 'window', from: sides[0], to: sides[1], wallId: wall.id, openingId: opening.id, locked });
      continue;
    }
    const door = doorByOpening.get(opening.id);
    const passableOpening = door ? true : (opening.sillHeight ?? 0) <= 1e-6 * scale && opening.height >= 1.8 * scale;
    if (!passableOpening) continue;
    edges.push({ id: door ? `door-${opening.id}` : `open-${opening.id}`, kind: door ? 'door' : 'open',
      from: sides[0], to: sides[1], wallId: wall.id, openingId: opening.id, doorId: door?.id,
      netWidthM: opening.width / scale, locked });
    connect(sides[0], sides[1]);
  }

  return { nodes, edges, nodeById, passable };
}

export function reachableFrom(graph: SpatialGraph, roots: string[]): Set<string> {
  const reached = new Set(roots);
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    for (const next of graph.passable[queue[i]] ?? []) {
      if (!reached.has(next)) { reached.add(next); queue.push(next); }
    }
  }
  return reached;
}

/** 封闭空间到入口/开放区不可达的物理空间 ID 列表。 */
export function unreachableSpaces(graph: SpatialGraph): string[] {
  const hasEntry = (graph.passable[OUTSIDE] ?? []).length > 0;
  const roots = hasEntry
    ? [OUTSIDE]
    : graph.nodes.filter((n) => n.kind === 'space' && !n.enclosed).map((n) => n.id);
  const reached = reachableFrom(graph, roots);
  return graph.nodes
    .filter((n) => n.kind === 'space' && (hasEntry || n.enclosed) && !reached.has(n.id))
    .map((n) => n.id);
}
