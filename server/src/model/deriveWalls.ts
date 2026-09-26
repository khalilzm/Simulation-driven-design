import type { SpaceModel, Vec2, Wall } from '@sdd/shared';
import { isPolygonClosed, roundCoord } from './geometry';
import {
  buildFloorAssignmentGrid,
  extractUnassignedBoundarySegments,
  labelPointInGrid,
  type FloorAssignmentGrid,
  type VoidBoundarySegment,
} from './voidRegions';

const EDGE_TOL = 0.05;
const SAMPLE_OFFSET = 0.02;
/** 短于该长度的原子边视为顶点焊接碎屑，不参与墙段合并 */
const MIN_WALL_SEGMENT_LEN = 0.05;

interface Segment {
  from: Vec2;
  to: Vec2;
}

type SideLabel = 'exterior' | 'void' | { space: string };

interface WallEdge {
  from: Vec2;
  to: Vec2;
  id: string;
}

function snap(p: Vec2): Vec2 {
  return [roundCoord(p[0]), roundCoord(p[1])];
}

function vtxKey(p: Vec2): string {
  const s = snap(p);
  return `${s[0]},${s[1]}`;
}

function edgeKey(a: Vec2, b: Vec2): string {
  const ka = vtxKey(a);
  const kb = vtxKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function segLen(a: Vec2, b: Vec2): number {
  return dist(a, b);
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

function pointOnSeg(p: Vec2, a: Vec2, b: Vec2, tol = EDGE_TOL): boolean {
  if (segLen(a, b) < 1e-9) return dist(p, a) <= tol;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
  if (t < -tol || t > 1 + tol) return false;
  const qx = a[0] + t * dx;
  const qy = a[1] + t * dy;
  return Math.hypot(p[0] - qx, p[1] - qy) <= tol;
}

function paramOnSeg(p: Vec2, a: Vec2, b: Vec2): number | null {
  const len = segLen(a, b);
  if (len < 1e-9) return null;
  if (!pointOnSeg(p, a, b)) return null;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
}

function intersectProper(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denom = cross2(r[0], r[1], s[0], s[1]);
  if (Math.abs(denom) < 1e-12) return null;
  const qp = [c[0] - a[0], c[1] - a[1]];
  const t = cross2(qp[0], qp[1], s[0], s[1]) / denom;
  const u = cross2(qp[0], qp[1], r[0], r[1]) / denom;
  if (t <= EDGE_TOL / (segLen(a, b) || 1) || t >= 1 - EDGE_TOL / (segLen(a, b) || 1)) return null;
  if (u <= EDGE_TOL / (segLen(c, d) || 1) || u >= 1 - EDGE_TOL / (segLen(c, d) || 1)) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

function spaceRing(boundary: Vec2[]): Vec2[] {
  if (boundary.length < 3) return [];
  const closed = isPolygonClosed(boundary, 1e-6);
  return closed ? boundary.slice(0, -1) : boundary;
}

function closeRing(ring: Vec2[]): Vec2[] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) return [...ring, first];
  return [...ring, ring[0]];
}

/** floor + spaces 顶点在容差内合并 */
function unifyPolygons(
  floorBoundary: Vec2[],
  spaces: { id: string; boundary: Vec2[] }[],
  tol = EDGE_TOL,
): { floor: Vec2[]; spaces: { id: string; boundary: Vec2[] }[] } {
  const reps: Vec2[] = [];
  const mapPoint = (p: Vec2): Vec2 => {
    const s = snap(p);
    for (const r of reps) {
      if (dist(s, r) <= tol) return r;
    }
    reps.push(s);
    return s;
  };
  const mapRing = (boundary: Vec2[]): Vec2[] => {
    const ring = spaceRing(boundary);
    const mapped = ring.map(mapPoint);
    return isPolygonClosed(boundary, 1e-6) ? closeRing(mapped) : mapped;
  };
  return {
    floor: mapRing(floorBoundary),
    spaces: spaces.map((s) => ({ id: s.id, boundary: mapRing(s.boundary) })),
  };
}

function polygonEdges(boundary: Vec2[]): Segment[] {
  const ring = spaceRing(boundary);
  const edges: Segment[] = [];
  for (let i = 0; i < ring.length; i++) {
    const from = snap(ring[i]);
    const to = snap(ring[(i + 1) % ring.length]);
    if (segLen(from, to) > 1e-6) edges.push({ from, to });
  }
  return edges;
}

function segmentOnSegment(inner: Segment, outer: Segment, tol = EDGE_TOL): boolean {
  return (
    pointOnSeg(inner.from, outer.from, outer.to, tol) &&
    pointOnSeg(inner.to, outer.from, outer.to, tol)
  );
}

function segmentOnFloorExterior(seg: Segment, floorBoundary: Vec2[]): boolean {
  for (const f of polygonEdges(floorBoundary)) {
    if (segmentOnSegment(seg, f)) return true;
  }
  return false;
}

function buildVoidBoundaryEdgeKeys(grid: FloorAssignmentGrid): Set<string> {
  const keys = new Set<string>();
  for (const seg of extractUnassignedBoundarySegments(grid)) {
    keys.add(edgeKey(seg.from, seg.to));
  }
  return keys;
}

function segmentOnSpaceBoundary(seg: Segment, spaces: { boundary: Vec2[] }[]): boolean {
  for (const space of spaces) {
    for (const edge of polygonEdges(space.boundary)) {
      if (segmentOnSegment(seg, edge)) return true;
    }
  }
  return false;
}

function collectRawSegments(
  floorBoundary: Vec2[],
  spaces: { boundary: Vec2[] }[],
  grid: FloorAssignmentGrid | null,
): Segment[] {
  const raw = polygonEdges(floorBoundary);
  for (const space of spaces) raw.push(...polygonEdges(space.boundary));
  if (grid) {
    for (const seg of extractUnassignedBoundarySegments(grid)) {
      const snapped = { from: snap(seg.from), to: snap(seg.to) };
      if (segmentOnSpaceBoundary(snapped, spaces)) continue;
      raw.push(snapped);
    }
  }
  return raw;
}

function splitPointsOnSegment(seg: Segment, all: Segment[]): Vec2[] {
  const pts: Vec2[] = [seg.from, seg.to];
  for (const other of all) {
    if (other === seg) continue;
    const hit = intersectProper(seg.from, seg.to, other.from, other.to);
    if (hit) pts.push(snap(hit));
    for (const p of [other.from, other.to]) {
      const t = paramOnSeg(p, seg.from, seg.to);
      if (t !== null && t > EDGE_TOL / (segLen(seg.from, seg.to) || 1) && t < 1 - EDGE_TOL / (segLen(seg.from, seg.to) || 1)) {
        pts.push(snap(p));
      }
    }
  }
  const uniq = new Map<string, Vec2>();
  for (const p of pts) uniq.set(vtxKey(p), snap(p));
  const sorted = [...uniq.values()].sort((a, b) => {
    const ta = paramOnSeg(a, seg.from, seg.to) ?? 0;
    const tb = paramOnSeg(b, seg.from, seg.to) ?? 0;
    return ta - tb;
  });
  return sorted;
}

/** 原子无向边（A→B 与 B→A 只保留一条） */
function atomicSegments(raw: Segment[]): Segment[] {
  const out: Segment[] = [];
  const seen = new Set<string>();
  for (const seg of raw) {
    const splits = splitPointsOnSegment(seg, raw);
    for (let i = 0; i + 1 < splits.length; i++) {
      const from = splits[i];
      const to = splits[i + 1];
      if (segLen(from, to) < 1e-6) continue;
      const k = edgeKey(from, to);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ from, to });
    }
  }
  return out;
}

function sideKey(label: SideLabel): string {
  if (label === 'exterior') return 'exterior';
  if (label === 'void') return 'void';
  return `space:${label.space}`;
}

function labelSide(p: Vec2, grid: FloorAssignmentGrid): SideLabel {
  return labelPointInGrid(p, grid, EDGE_TOL);
}

/** 基于中点两侧采样判定是否为墙；正反向为同一条无向边 */
function classifyWallEdge(
  seg: Segment,
  floorBoundary: Vec2[],
  grid: FloorAssignmentGrid,
  voidBoundaryEdges: Set<string>,
): boolean {
  const len = segLen(seg.from, seg.to);
  if (len < 1e-6) return false;

  const segKey = edgeKey(seg.from, seg.to);
  if (voidBoundaryEdges.has(segKey)) return true;

  const mid = midpoint(seg.from, seg.to);
  const ux = (seg.to[0] - seg.from[0]) / len;
  const uy = (seg.to[1] - seg.from[1]) / len;
  const nx = -uy;
  const ny = ux;
  const pL: Vec2 = [mid[0] + nx * SAMPLE_OFFSET, mid[1] + ny * SAMPLE_OFFSET];
  const pR: Vec2 = [mid[0] - nx * SAMPLE_OFFSET, mid[1] - ny * SAMPLE_OFFSET];

  const left = labelSide(pL, grid);
  const right = labelSide(pR, grid);
  const lk = sideKey(left);
  const rk = sideKey(right);

  if (lk === rk) return false;
  if (lk === 'exterior' && rk === 'exterior') return false;

  if (lk === 'exterior' || rk === 'exterior') return true;
  if (segmentOnFloorExterior(seg, floorBoundary)) return true;

  return true;
}

function collinearAt(prev: Vec2, joint: Vec2, next: Vec2): boolean {
  const ax = joint[0] - prev[0];
  const ay = joint[1] - prev[1];
  const bx = next[0] - joint[0];
  const by = next[1] - joint[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return false;
  return Math.abs(cross2(ax / la, ay / la, bx / lb, by / lb)) < 1e-4;
}

function dedupeChain(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const s = snap(p);
    const last = out[out.length - 1];
    if (last && vtxKey(last) === vtxKey(s)) continue;
    out.push(s);
  }
  return out;
}

function simplifyCollinearChain(points: Vec2[]): Vec2[] {
  if (points.length <= 2) return points;
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (collinearAt(out[out.length - 1], points[i], points[i + 1])) continue;
    out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** DFS 沿共线墙段合并为 polyline 中心线 */
function mergeWallEdgesWithDfs(edges: WallEdge[]): Vec2[][] {
  const adj = new Map<string, { point: Vec2; edge: WallEdge }[]>();
  for (const e of edges) {
    const a = vtxKey(e.from);
    const b = vtxKey(e.to);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ point: e.to, edge: e });
    adj.get(b)!.push({ point: e.from, edge: e });
  }

  const used = new Set<string>();
  const chains: Vec2[][] = [];

  const extend = (prev: Vec2, current: Vec2): Vec2[] => {
    const out: Vec2[] = [];
    let p = prev;
    let c = current;
    while (true) {
      const ck = vtxKey(c);
      const candidates = (adj.get(ck) ?? []).filter(
        (n) =>
          !used.has(n.edge.id) &&
          vtxKey(n.point) !== vtxKey(p) &&
          collinearAt(p, c, n.point),
      );
      if (candidates.length === 0) break;
      const next =
        candidates.length === 1
          ? candidates[0]
          : candidates.reduce((best, n) =>
              segLen(c, n.point) > segLen(c, best.point) ? n : best,
            );
      used.add(next.edge.id);
      p = c;
      c = next.point;
      out.push(c);
    }
    return out;
  };

  for (const e of edges) {
    if (used.has(e.id)) continue;
    used.add(e.id);
    const tail = extend(e.from, e.to);
    const head = extend(e.to, e.from);
    head.reverse();
    const chain = simplifyCollinearChain(dedupeChain([...head, e.from, e.to, ...tail]));
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

function chainsToWalls(
  chains: Vec2[][],
  height: number,
  thickness: number,
  startIndex: number,
): Wall[] {
  return chains.map((points, i) => ({
    id: `wall-${String(startIndex + i + 1).padStart(2, '0')}`,
    geometry: { type: 'polyline', points },
    thickness,
    height,
    fixed: false,
  }));
}

/**
 * 将 floor + spaces 注册到统一平面图：交点拆分 → 无向边分类 → DFS 合并中心线。
 * 正方向与反方向为同一条墙。
 */
export function wallsFromPlanarGraph(
  floorBoundary: Vec2[],
  spaces: { id: string; boundary: Vec2[] }[],
  height: number,
  options?: { thickness?: number },
): Wall[] {
  const thickness = options?.thickness ?? 0.12;

  if (spaces.length === 0) {
    const { floor } = unifyPolygons(floorBoundary, []);
    const grid = buildFloorAssignmentGrid(floor, []);
    const raw = collectRawSegments(floor, [], grid);
    const atomic = atomicSegments(raw);
    const wallEdges: WallEdge[] = [];
    let eid = 0;
    for (const seg of atomic) {
      if (!segmentOnFloorExterior(seg, floor)) continue;
      wallEdges.push({ from: seg.from, to: seg.to, id: `e-${eid++}` });
    }
    const chains = mergeWallEdgesWithDfs(wallEdges);
    return chainsToWalls(chains, height, thickness, 0);
  }

  const { floor, spaces: unifiedSpaces } = unifyPolygons(floorBoundary, spaces);
  const grid = buildFloorAssignmentGrid(floor, unifiedSpaces);
  const voidBoundaryEdges = grid ? buildVoidBoundaryEdgeKeys(grid) : new Set<string>();
  const raw = collectRawSegments(floor, unifiedSpaces, grid);
  const atomic = atomicSegments(raw);

  const wallEdges: WallEdge[] = [];
  let eid = 0;

  for (const seg of atomic) {
    if (!grid) continue;
    if (segLen(seg.from, seg.to) < MIN_WALL_SEGMENT_LEN) continue;
    if (!classifyWallEdge(seg, floor, grid, voidBoundaryEdges)) continue;
    wallEdges.push({ from: seg.from, to: seg.to, id: `e-${eid++}` });
  }

  const chains = mergeWallEdgesWithDfs(wallEdges);
  return chainsToWalls(chains, height, thickness, 0);
}

/** @deprecated 墙体由 Agent 生成，不再后处理派生 */
export function deriveWallsIfEmpty(model: SpaceModel): SpaceModel {
  return model;
}

/** @deprecated 使用 wallsFromPlanarGraph */
export function interiorWallsFromSpaces(
  spaces: { id: string; boundary: Vec2[] }[],
  floorBoundary: Vec2[],
  height: number,
  thickness = 0.12,
): Wall[] {
  return wallsFromPlanarGraph(floorBoundary, spaces, height, { thickness });
}
