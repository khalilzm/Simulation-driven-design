import type { Vec2 } from '@sdd/shared';
import { isPolygonClosed, pointInPolygon, pointInPolygonOrOnEdge, roundCoord } from './geometry';

const TOL = 0.05;

function spaceRing(boundary: Vec2[]): Vec2[] {
  if (boundary.length < 3) return [];
  const closed = isPolygonClosed(boundary, 1e-6);
  return closed ? boundary.slice(0, -1) : boundary;
}

function snapCoord(v: number): number {
  return roundCoord(v);
}

export type CellLabel = 'exterior' | 'void' | number;

export interface FloorAssignmentGrid {
  xu: number[];
  yu: number[];
  labels: CellLabel[][];
  floorClosed: Vec2[];
  spaceRings: Vec2[][];
  spaceIds: string[];
}

export interface VoidBoundarySegment {
  from: Vec2;
  to: Vec2;
  neighbor: 'exterior' | { space: string };
}

function edgeKey(a: Vec2, b: Vec2): string {
  const ak = `${snapCoord(a[0])},${snapCoord(a[1])}`;
  const bk = `${snapCoord(b[0])},${snapCoord(b[1])}`;
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function findCellIndex(coord: number, coords: number[]): number {
  for (let i = 0; i < coords.length - 1; i++) {
    if (coord >= coords[i] && coord < coords[i + 1]) return i;
  }
  if (coords.length >= 2 && coord === coords[coords.length - 1]) {
    return coords.length - 2;
  }
  return -1;
}

function neighborLabel(
  labels: CellLabel[][],
  spaceIds: string[],
  ii: number,
  jj: number,
): 'exterior' | { space: string } {
  const cols = labels.length;
  const rows = labels[0]?.length ?? 0;
  if (ii < 0 || ii >= cols || jj < 0 || jj >= rows) return 'exterior';
  const lab = labels[ii][jj];
  if (lab === 'exterior' || lab === 'void') return 'exterior';
  return { space: spaceIds[lab] };
}

/** floor 网格：每个 cell 标记 exterior / void / space 索引 */
export function buildFloorAssignmentGrid(
  floorBoundary: Vec2[],
  spaces: { id: string; boundary: Vec2[] }[],
  tol = TOL,
): FloorAssignmentGrid | null {
  const floorRing = spaceRing(floorBoundary);
  if (floorRing.length < 3) return null;

  const spaceRings = spaces
    .map((s) => spaceRing(s.boundary))
    .filter((r) => r.length >= 3);
  const spaceIds = spaces.map((s) => s.id);

  const xs = new Set<number>();
  const ys = new Set<number>();
  const add = (p: Vec2) => {
    xs.add(snapCoord(p[0]));
    ys.add(snapCoord(p[1]));
  };
  for (const p of floorRing) add(p);
  for (const ring of spaceRings) for (const p of ring) add(p);

  const xu = [...xs].sort((a, b) => a - b);
  const yu = [...ys].sort((a, b) => a - b);
  if (xu.length < 2 || yu.length < 2) return null;

  const floorClosed = isPolygonClosed(floorBoundary, 1e-6)
    ? floorBoundary
    : [...floorRing, floorRing[0]];

  const cols = xu.length - 1;
  const rows = yu.length - 1;
  const labels: CellLabel[][] = Array.from({ length: cols }, (_, i) =>
    Array.from({ length: rows }, (_, j) => {
      const cx = (xu[i] + xu[i + 1]) / 2;
      const cy = (yu[j] + yu[j + 1]) / 2;
      const p: Vec2 = [cx, cy];
      if (!pointInPolygonOrOnEdge(p, floorClosed, tol)) return 'exterior';
      for (let k = 0; k < spaceRings.length; k++) {
        if (pointInPolygon(p, spaceRings[k])) return k;
      }
      return 'void';
    }),
  );

  return { xu, yu, labels, floorClosed, spaceRings, spaceIds };
}

/** 基于网格（主）+ 多边形（回退），判定采样点所属侧 */
export function labelPointInGrid(
  p: Vec2,
  grid: FloorAssignmentGrid,
  tol = TOL,
): 'exterior' | 'void' | { space: string } {
  if (!pointInPolygonOrOnEdge(p, grid.floorClosed, tol)) return 'exterior';

  const ci = findCellIndex(p[0], grid.xu);
  const cj = findCellIndex(p[1], grid.yu);
  if (ci >= 0 && cj >= 0 && ci < grid.labels.length && cj < grid.labels[0].length) {
    const lab = grid.labels[ci][cj];
    if (lab === 'exterior') return 'exterior';
    if (lab === 'void') return 'void';
    return { space: grid.spaceIds[lab] };
  }

  for (let k = 0; k < grid.spaceRings.length; k++) {
    const ring = grid.spaceRings[k];
    if (ring.length >= 3 && pointInPolygon(p, ring)) {
      return { space: grid.spaceIds[k] };
    }
  }

  return 'void';
}

/** void 区域外轮廓边（网格边），一侧 void、另一侧 space 或 exterior */
export function extractUnassignedBoundarySegments(
  grid: FloorAssignmentGrid,
): VoidBoundarySegment[] {
  const { xu, yu, labels, spaceIds } = grid;
  const cols = labels.length;
  const rows = labels[0]?.length ?? 0;
  if (cols === 0 || rows === 0) return [];

  const segments: VoidBoundarySegment[] = [];
  const seen = new Set<string>();

  const isVoid = (ii: number, jj: number) =>
    ii >= 0 && ii < cols && jj >= 0 && jj < rows && labels[ii][jj] === 'void';

  const push = (from: Vec2, to: Vec2, neighbor: 'exterior' | { space: string }) => {
    const k = edgeKey(from, to);
    if (seen.has(k)) return;
    seen.add(k);
    segments.push({ from, to, neighbor });
  };

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (labels[i][j] !== 'void') continue;

      const x0 = xu[i];
      const x1 = xu[i + 1];
      const y0 = yu[j];
      const y1 = yu[j + 1];

      if (!isVoid(i - 1, j)) {
        push([x0, y0], [x0, y1], neighborLabel(labels, spaceIds, i - 1, j));
      }
      if (!isVoid(i + 1, j)) {
        push([x1, y1], [x1, y0], neighborLabel(labels, spaceIds, i + 1, j));
      }
      if (!isVoid(i, j - 1)) {
        push([x0, y0], [x1, y0], neighborLabel(labels, spaceIds, i, j - 1));
      }
      if (!isVoid(i, j + 1)) {
        push([x1, y1], [x0, y1], neighborLabel(labels, spaceIds, i, j + 1));
      }
    }
  }

  return segments;
}

/** floor 内未被任何 space 覆盖的区域，提取为闭合多边形（调试用） */
export function extractUnassignedBoundaries(
  floorBoundary: Vec2[],
  spaces: { id: string; boundary: Vec2[] }[],
): Vec2[][] {
  const grid = buildFloorAssignmentGrid(floorBoundary, spaces);
  if (!grid) return [];

  const { xu, yu, labels } = grid;
  const cols = labels.length;
  const rows = labels[0]?.length ?? 0;

  const visited = Array.from({ length: cols }, () => Array(rows).fill(false));
  const polygons: Vec2[][] = [];

  interface GridCell {
    i: number;
    j: number;
  }

  interface GridEdge {
    from: Vec2;
    to: Vec2;
  }

  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (labels[i][j] !== 'void' || visited[i][j]) continue;

      const component: GridCell[] = [];
      const stack: GridCell[] = [{ i, j }];
      visited[i][j] = true;

      while (stack.length) {
        const c = stack.pop()!;
        component.push(c);
        const neighbors: GridCell[] = [
          { i: c.i - 1, j: c.j },
          { i: c.i + 1, j: c.j },
          { i: c.i, j: c.j - 1 },
          { i: c.i, j: c.j + 1 },
        ];
        for (const n of neighbors) {
          if (n.i < 0 || n.i >= cols || n.j < 0 || n.j >= rows) continue;
          if (visited[n.i][n.j] || labels[n.i][n.j] !== 'void') continue;
          visited[n.i][n.j] = true;
          stack.push(n);
        }
      }

      const boundaryEdges: GridEdge[] = [];
      const seen = new Set<string>();

      const isVoid = (ii: number, jj: number) =>
        ii >= 0 && ii < cols && jj >= 0 && jj < rows && labels[ii][jj] === 'void';

      for (const { i: ci, j: cj } of component) {
        const x0 = xu[ci];
        const x1 = xu[ci + 1];
        const y0 = yu[cj];
        const y1 = yu[cj + 1];

        if (!isVoid(ci - 1, cj)) {
          const e = { from: [x0, y0] as Vec2, to: [x0, y1] as Vec2 };
          const k = edgeKey(e.from, e.to);
          if (!seen.has(k)) { seen.add(k); boundaryEdges.push(e); }
        }
        if (!isVoid(ci + 1, cj)) {
          const e = { from: [x1, y1] as Vec2, to: [x1, y0] as Vec2 };
          const k = edgeKey(e.from, e.to);
          if (!seen.has(k)) { seen.add(k); boundaryEdges.push(e); }
        }
        if (!isVoid(ci, cj - 1)) {
          const e = { from: [x0, y0] as Vec2, to: [x1, y0] as Vec2 };
          const k = edgeKey(e.from, e.to);
          if (!seen.has(k)) { seen.add(k); boundaryEdges.push(e); }
        }
        if (!isVoid(ci, cj + 1)) {
          const e = { from: [x1, y1] as Vec2, to: [x0, y1] as Vec2 };
          const k = edgeKey(e.from, e.to);
          if (!seen.has(k)) { seen.add(k); boundaryEdges.push(e); }
        }
      }

      const ring = stitchBoundaryRing(boundaryEdges);
      if (ring && ring.length >= 3) polygons.push(ring);
    }
  }

  return polygons;
}

function stitchBoundaryRing(edges: { from: Vec2; to: Vec2 }[]): Vec2[] | null {
  if (edges.length === 0) return null;

  const adj = new Map<string, Vec2[]>();
  for (const e of edges) {
    const a = vtx(e.from);
    const b = vtx(e.to);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(e.to);
    adj.get(b)!.push(e.from);
  }

  const start = vtx(edges[0].from);
  const ring: Vec2[] = [edges[0].from];
  let prev = edges[0].from;
  let cur = edges[0].to;
  const used = new Set<string>();
  used.add(edgeId(edges[0].from, edges[0].to));

  for (let step = 0; step < edges.length + 2; step++) {
    ring.push(cur);
    const ck = vtx(cur);
    const nexts = (adj.get(ck) ?? []).filter((n) => vtx(n) !== vtx(prev));
    let next: Vec2 | null = null;
    for (const n of nexts) {
      const id = edgeId(cur, n);
      if (!used.has(id)) {
        next = n;
        used.add(id);
        break;
      }
    }
    if (!next) break;
    if (vtx(next) === start && ring.length >= 3) {
      return ring;
    }
    prev = cur;
    cur = next;
  }

  if (ring.length >= 3 && vtx(ring[0]) === vtx(ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return ring.length >= 3 ? ring : null;
}

function vtx(p: Vec2): string {
  return `${snapCoord(p[0])},${snapCoord(p[1])}`;
}

function edgeId(a: Vec2, b: Vec2): string {
  const ak = vtx(a);
  const bk = vtx(b);
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}
