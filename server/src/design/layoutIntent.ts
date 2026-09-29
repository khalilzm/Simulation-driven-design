import type { SpaceModel, Vec2 } from '@sdd/shared';
import { boundsOf, closePolygon, polygonArea, type Bounds } from '../model/geometry';
import type { AdjacencyIntent, CirculationIntent, CirculationOrientation, DesignIntent, DoorIntent, Orientation, RoomIntent, WindowIntent } from './intent';
import type { LayoutContext } from './layoutContext';
import type {
  LayoutBoundarySpec,
  LayoutDoorSpec,
  LayoutOpeningSpec,
  LayoutPlanV2,
  LayoutSpaceSpec,
  LayoutWindowSpec,
} from './layoutPlanTypes';
import { compileLayoutPlan } from './compileLayoutPlan';
import { cleanRing, decomposeRegions, sharedSegments, splitRegion, unionRings } from './regionGeometry';

export interface IntentLayoutOutput {
  plan: LayoutPlanV2;
  warnings: string[];
}

interface Cell {
  boundary: Vec2[];
  areaM2: number;
  touches: Cardinal[];
  neighbors: number[];
}

interface PlacedRoom {
  room: RoomIntent;
  boundary: Vec2[];
}

type Cardinal = 'south' | 'north' | 'east' | 'west';

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Ladybug north_angle=0 约定：北=+Y，南=-Y，东=+X，西=-X。 */
function cardinal(o: Orientation): Cardinal {
  if (o.includes('south')) return 'south';
  if (o.includes('north')) return 'north';
  return o === 'east' ? 'east' : 'west';
}

function rectOf(r: Rect): Vec2[] {
  return [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
}

function rectArea(r: Rect): number {
  return (r.x1 - r.x0) * (r.y1 - r.y0);
}

function defaultArea(rooms: RoomIntent[]): number {
  const areas = rooms
    .map((room) => room.area.target ?? room.area.min)
    .filter((value): value is number => value !== undefined);
  return areas.length ? areas.reduce((sum, value) => sum + value, 0) / areas.length : 10;
}

function segLength(seg: [Vec2, Vec2]): number {
  return Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]);
}

/** 把外轮廓过分割成足够多的凸单元：先拆凹轮廓，再对最大单元沿长边二分。 */
function overPartition(floor: Vec2[], targetCells: number): Vec2[][] {
  let cells = decomposeRegions([closePolygon(floor, 0)]).map(cleanRing);
  while (cells.length < targetCells) {
    const idx = cells.reduce((best, _c, i) => (polygonArea(cells[best]) < polygonArea(cells[i]) ? i : best), 0);
    const cell = cells[idx];
    const b = boundsOf(cell)!;
    const axis: 'x' | 'y' = b.maxX - b.minX >= b.maxY - b.minY ? 'x' : 'y';
    const parts = splitRegion(cell, axis, 0.5);
    cells.splice(idx, 1, ...parts.map(cleanRing));
  }
  return cells;
}

function buildCells(rings: Vec2[][], floorBounds: Bounds, scale: number): Cell[] {
  const eps = 1e-6 * scale;
  const cells: Cell[] = rings.map((ring) => {
    const boundary = cleanRing(ring);
    const bb = boundsOf(boundary)!;
    const touches: Cardinal[] = [];
    if (Math.abs(bb.minY - floorBounds.minY) < eps) touches.push('south');
    if (Math.abs(bb.maxY - floorBounds.maxY) < eps) touches.push('north');
    if (Math.abs(bb.maxX - floorBounds.maxX) < eps) touches.push('east');
    if (Math.abs(bb.minX - floorBounds.minX) < eps) touches.push('west');
    return { boundary, areaM2: polygonArea(boundary) / scale ** 2, touches, neighbors: [] };
  });
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      if (sharedSegments(cells[i].boundary, cells[j].boundary).length) {
        cells[i].neighbors.push(j);
        cells[j].neighbors.push(i);
      }
    }
  }
  return cells;
}

/** 关系图：adjacent / separated 的房间对（无向）。 */
function buildRelationMap(adjacencies: AdjacencyIntent[], relation: 'adjacent' | 'separated'): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const get = (id: string) => {
    let s = map.get(id);
    if (!s) { s = new Set(); map.set(id, s); }
    return s;
  };
  for (const adj of adjacencies) {
    if (adj.relation !== relation) continue;
    get(adj.a).add(adj.b);
    get(adj.b).add(adj.a);
  }
  return map;
}

function touchesBoundary(a: Vec2[], b: Vec2[]): boolean {
  return sharedSegments(a, b).length > 0;
}

/** 邻接图贪心排序：adjacent 房间相邻，tie-break 朝向稀缺。 */
function orderByAdjacency(rooms: RoomIntent[], adjMap: Map<string, Set<string>>, scarcity: (r: RoomIntent) => number): RoomIntent[] {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const remaining = new Set(rooms.map((r) => r.id));
  const order: RoomIntent[] = [];
  while (remaining.size) {
    const start = [...remaining].sort((a, b) =>
      (adjMap.get(b)?.size ?? 0) - (adjMap.get(a)?.size ?? 0) ||
      scarcity(byId.get(a)!) - scarcity(byId.get(b)!))[0];
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (!remaining.has(id)) continue;
      remaining.delete(id);
      order.push(byId.get(id)!);
      const neighbors = [...(adjMap.get(id) ?? [])].filter((n) => remaining.has(n))
        .sort((a, b) => scarcity(byId.get(a)!) - scarcity(byId.get(b)!));
      for (const n of neighbors) stack.push(n);
    }
  }
  return order;
}

/** 房间吃相邻单元：门 connects（最高）、朝向贴边、adjacent 相邻、separated 避让，按面积合并成房间边界。 */
function assignRooms(
  rooms: RoomIntent[],
  cells: Cell[],
  adjacencies: AdjacencyIntent[],
  doors: DoorIntent[],
  references: { id: string; boundary: Vec2[] }[],
): PlacedRoom[] {
  const used = new Set<number>();
  const placed: PlacedRoom[] = [];
  const placedByRoom = new Map<string, PlacedRoom>();
  const eatenByRoom = new Map<PlacedRoom, number[]>();
  const adjMap = buildRelationMap(adjacencies, 'adjacent');
  const sepMap = buildRelationMap(adjacencies, 'separated');
  const doorMap = new Map<string, Set<string>>();
  for (const d of doors) {
    let a = doorMap.get(d.connects[0]);
    if (!a) { a = new Set(); doorMap.set(d.connects[0], a); }
    a.add(d.connects[1]);
    let b = doorMap.get(d.connects[1]);
    if (!b) { b = new Set(); doorMap.set(d.connects[1], b); }
    b.add(d.connects[0]);
  }
  const refBoundary = new Map<string, Vec2[]>();
  for (const r of references) refBoundary.set(r.id, r.boundary);

  const sideCount: Record<Cardinal, number> = { south: 0, north: 0, east: 0, west: 0 };
  for (const cell of cells) for (const t of cell.touches) sideCount[t]++;
  const scarcity = (room: RoomIntent): number => {
    const dir = room.orientation?.length ? cardinal(room.orientation[0]) : undefined;
    return dir ? sideCount[dir] : Number.POSITIVE_INFINITY;
  };

  // 比例放大 target 填满可用单元（留 15% 缓冲吸收贪心取整误差），保持各房间相对比例。
  const rawTargets = rooms.map((r) => r.area.target ?? r.area.min ?? 10);
  const totalTarget = rawTargets.reduce((s, t) => s + t, 0);
  const regionArea = cells.reduce((s, c) => s + c.areaM2, 0);
  const fillTarget = regionArea * 0.85;
  const factor = totalTarget > 0 && fillTarget > totalTarget ? fillTarget / totalTarget : 1;
  const scaledRooms = factor === 1
    ? rooms
    : rooms.map((r, i) => ({ ...r, area: { ...r.area, target: Math.max(rawTargets[i] * factor, r.area.min ?? 0) } }));

  const ordered = orderByAdjacency(scaledRooms, adjMap, scarcity);

  for (const room of ordered) {
    const target = room.area.target ?? room.area.min ?? 10;
    const dir = room.orientation?.length ? cardinal(room.orientation[0]) : undefined;

    let candidates = cells.map((c, i) => ({ c, i })).filter(({ c, i }) => !used.has(i));
    if (!candidates.length) break;

    // 1. 门 connects 引力（最高：门必须开在两空间共享墙上）
    const doorBoundaries: Vec2[][] = [];
    for (const tid of doorMap.get(room.id) ?? []) {
      const p = placedByRoom.get(tid);
      if (p) doorBoundaries.push(p.boundary);
      else {
        const rb = refBoundary.get(tid);
        if (rb) doorBoundaries.push(rb);
      }
    }
    if (doorBoundaries.length) {
      const doorCells = candidates.filter(({ c }) => doorBoundaries.some((b) => touchesBoundary(c.boundary, b)));
      if (doorCells.length) candidates = doorCells;
    }

    // 2. 朝向贴边
    if (dir) {
      const oriented = candidates.filter(({ c }) => c.touches.includes(dir));
      if (oriented.length) candidates = oriented;
    }

    // 3. adjacent 相邻
    const adjPlaced = [...(adjMap.get(room.id) ?? [])].filter((id) => placedByRoom.has(id));
    if (adjPlaced.length) {
      const adjacentCells = candidates.filter(({ c }) => adjPlaced.some((id) => touchesBoundary(c.boundary, placedByRoom.get(id)!.boundary)));
      if (adjacentCells.length) candidates = adjacentCells;
    }

    // 4. separated 避让
    const sepPlaced = [...(sepMap.get(room.id) ?? [])].filter((id) => placedByRoom.has(id));
    if (sepPlaced.length) {
      const nonSep = candidates.filter(({ c }) => !sepPlaced.some((id) => touchesBoundary(c.boundary, placedByRoom.get(id)!.boundary)));
      if (nonSep.length) candidates = nonSep;
    }

    candidates.sort((a, b) => Math.abs(a.c.areaM2 - target) - Math.abs(b.c.areaM2 - target));
    const start = candidates[0].i;
    const eaten = [start];
    used.add(start);
    let area = cells[start].areaM2;
    const queue = [...cells[start].neighbors].filter((n) => !used.has(n));
    while (area < target && queue.length) {
      const next = queue.shift()!;
      if (used.has(next)) continue;
      eaten.push(next);
      used.add(next);
      area += cells[next].areaM2;
      for (const n of cells[next].neighbors) if (!used.has(n) && !queue.includes(n)) queue.push(n);
    }

    const combined = unionRings(eaten.map((i) => cells[i].boundary));
    const boundary = combined.length ? cleanRing(combined[0][0]) : [];
    if (boundary.length >= 3) {
      const p = { room, boundary };
      placed.push(p);
      placedByRoom.set(room.id, p);
      eatenByRoom.set(p, eaten);
    }
  }

  // 回填空余：反复让相对最「欠面积」且能扩展的房间并入一个相邻单元，按比例填满该区域。
  for (;;) {
    let best: PlacedRoom | null = null;
    let bestRatio = Infinity;
    let bestCell = -1;
    for (const p of placed) {
      const target = p.room.area.target ?? p.room.area.min ?? 10;
      const area = eatenByRoom.get(p)!.reduce((s, ci) => s + cells[ci].areaM2, 0);
      const ratio = area / Math.max(target, 1e-9);
      if (ratio >= bestRatio) continue;
      const cellIndex = cells.findIndex((c, i) => !used.has(i) && sharedSegments(c.boundary, p.boundary).length > 0);
      if (cellIndex >= 0) { bestRatio = ratio; best = p; bestCell = cellIndex; }
    }
    if (!best || bestCell < 0) break;
    used.add(bestCell);
    const eaten = eatenByRoom.get(best)!;
    eaten.push(bestCell);
    const combined = unionRings(eaten.map((ci) => cells[ci].boundary));
    if (combined.length) best.boundary = cleanRing(combined[0][0]);
  }

  return placed;
}

function rectToRing(rect: Rect): Vec2[] {
  return [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1], [rect.x0, rect.y0]];
}

function roomArea(r: RoomIntent): number {
  return Math.max(r.area.target ?? r.area.min ?? 10, 1e-6);
}

function areaSum(rooms: RoomIntent[]): number {
  return rooms.reduce((s, r) => s + roomArea(r), 0);
}

/** 外轮廓是否为矩形（包围盒面积 ≈ 多边形面积）。 */
function isRectangular(boundary: Vec2[]): boolean {
  const b = boundsOf(boundary)!;
  const bboxArea = (b.maxX - b.minX) * (b.maxY - b.minY);
  return Math.abs(bboxArea - polygonArea(boundary)) < 1e-6 * Math.max(bboxArea, 1);
}

/**
 * 精确切分：按面积比例递归二分矩形区域。面积严格贴合 target 比例、铺满、正交矩形；
 * 南/北/西/东朝向各自贴到对应边，其余房间按面积平衡，并尽量让 separated 房间不相邻。
 */
function partitionRooms(rooms: RoomIntent[], rect: Rect, adjacencies: AdjacencyIntent[] = []): { room: RoomIntent; rect: Rect }[] {
  if (!rooms.length) return [];
  if (rooms.length === 1) return [{ room: rooms[0], rect }];

  const sepMap = buildRelationMap(adjacencies, 'separated');
  const isSeparated = (a: RoomIntent, b: RoomIntent): boolean => sepMap.get(a.id)?.has(b.id) ?? false;

  const dirOf = (r: RoomIntent): Cardinal | undefined =>
    r.orientation?.length ? cardinal(r.orientation[0]) : undefined;
  const hasSouth = rooms.some((r) => dirOf(r) === 'south');
  const hasNorth = rooms.some((r) => dirOf(r) === 'north');
  const hasEast = rooms.some((r) => dirOf(r) === 'east');
  const hasWest = rooms.some((r) => dirOf(r) === 'west');

  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  const horizontal = (hasSouth && hasNorth) || (!hasEast && !hasWest && height >= width);

  const assign = (r: RoomIntent, groupA: RoomIntent[], groupB: RoomIntent[]): void => {
    const sepA = groupA.some((g) => isSeparated(r, g));
    const sepB = groupB.some((g) => isSeparated(r, g));
    if (sepA && !sepB) groupB.push(r);
    else if (sepB && !sepA) groupA.push(r);
    else (areaSum(groupA) <= areaSum(groupB) ? groupA : groupB).push(r);
  };

  let groupA: RoomIntent[];
  let groupB: RoomIntent[];
  if (horizontal) {
    groupA = rooms.filter((r) => dirOf(r) === 'south');
    groupB = rooms.filter((r) => dirOf(r) === 'north');
    for (const r of rooms) {
      if (dirOf(r) === 'south' || dirOf(r) === 'north') continue;
      assign(r, groupA, groupB);
    }
  } else {
    groupA = rooms.filter((r) => dirOf(r) === 'west');
    groupB = rooms.filter((r) => dirOf(r) === 'east');
    for (const r of rooms) {
      if (dirOf(r) === 'west' || dirOf(r) === 'east') continue;
      assign(r, groupA, groupB);
    }
  }

  if (!groupA.length || !groupB.length) {
    groupA = [rooms[0]];
    groupB = [];
    for (const r of rooms.slice(1)) assign(r, groupA, groupB);
  }

  const areaA = areaSum(groupA);
  const ratio = areaA / Math.max(areaA + areaSum(groupB), 1e-9);

  let rectA: Rect, rectB: Rect;
  if (horizontal) {
    const splitY = rect.y0 + height * ratio;
    rectA = { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: splitY };
    rectB = { x0: rect.x0, y0: splitY, x1: rect.x1, y1: rect.y1 };
  } else {
    const splitX = rect.x0 + width * ratio;
    rectA = { x0: rect.x0, y0: rect.y0, x1: splitX, y1: rect.y1 };
    rectB = { x0: splitX, y0: rect.y0, x1: rect.x1, y1: rect.y1 };
  }

  return [...partitionRooms(groupA, rectA, adjacencies), ...partitionRooms(groupB, rectB, adjacencies)];
}

/** 在矩形区域内按面积精确切分房间（无走廊骨架的填充路径）。 */
function layoutFill(rooms: RoomIntent[], region: Vec2[], floorBounds: Bounds, fallback: number, scale: number, adjacencies: AdjacencyIntent[], doors: DoorIntent[], references: { id: string; boundary: Vec2[] }[]): PlacedRoom[] {
  if (!rooms.length) return [];
  const b = boundsOf(region)!;
  const rect: Rect = { x0: b.minX, y0: b.minY, x1: b.maxX, y1: b.maxY };
  return partitionRooms(rooms, rect, adjacencies).map(({ room, rect }) => ({ room, boundary: rectToRing(rect) }));
}

/** 放置一条贯穿的走廊，position 决定其沿主方向的位置。 */
function placeCorridor(c: CirculationIntent, floorBounds: Bounds, scale: number): Rect {
  const w = (c.width ?? 1.5) * scale;
  if (c.orientation === 'horizontal') {
    if (c.position === 'start') return { x0: floorBounds.minX, y0: floorBounds.minY, x1: floorBounds.maxX, y1: floorBounds.minY + w };
    if (c.position === 'end') return { x0: floorBounds.minX, y0: floorBounds.maxY - w, x1: floorBounds.maxX, y1: floorBounds.maxY };
    const cy = (floorBounds.minY + floorBounds.maxY) / 2;
    return { x0: floorBounds.minX, y0: cy - w / 2, x1: floorBounds.maxX, y1: cy + w / 2 };
  }
  if (c.position === 'start') return { x0: floorBounds.minX, y0: floorBounds.minY, x1: floorBounds.minX + w, y1: floorBounds.maxY };
  if (c.position === 'end') return { x0: floorBounds.maxX - w, y0: floorBounds.minY, x1: floorBounds.maxX, y1: floorBounds.maxY };
  const cx = (floorBounds.minX + floorBounds.maxX) / 2;
  return { x0: cx - w / 2, y0: floorBounds.minY, x1: cx + w / 2, y1: floorBounds.maxY };
}

/** 走廊两侧的剩余矩形区域。 */
function corridorSides(rect: Rect, orientation: CirculationOrientation, floorBounds: Bounds): [Rect, Rect] {
  if (orientation === 'horizontal') {
    return [
      { x0: floorBounds.minX, y0: floorBounds.minY, x1: floorBounds.maxX, y1: rect.y0 },
      { x0: floorBounds.minX, y0: rect.y1, x1: floorBounds.maxX, y1: floorBounds.maxY },
    ];
  }
  return [
    { x0: floorBounds.minX, y0: floorBounds.minY, x1: rect.x0, y1: floorBounds.maxY },
    { x0: rect.x1, y0: floorBounds.minY, x1: floorBounds.maxX, y1: floorBounds.maxY },
  ];
}

/** 房间按朝向分到走廊两侧；无朝向房间按面积平衡分配。 */
function splitRooms(rooms: RoomIntent[], orientation: CirculationOrientation): { aRooms: RoomIntent[]; bRooms: RoomIntent[] } {
  const aRooms: RoomIntent[] = [];
  const bRooms: RoomIntent[] = [];
  const dirA: Cardinal = orientation === 'horizontal' ? 'south' : 'west';
  const dirB: Cardinal = orientation === 'horizontal' ? 'north' : 'east';
  const areaSum = (list: RoomIntent[]) => list.reduce((s, r) => s + (r.area.target ?? r.area.min ?? 10), 0);
  for (const room of rooms) {
    const dir = room.orientation?.length ? cardinal(room.orientation[0]) : undefined;
    if (dir === dirA) aRooms.push(room);
    else if (dir === dirB) bRooms.push(room);
    else (areaSum(aRooms) <= areaSum(bRooms) ? aRooms : bRooms).push(room);
  }
  return { aRooms, bRooms };
}

/** 走廊骨架布局：先放走廊，房间分两侧填充，走廊为开放交通区。 */
function layoutWithCirculation(intent: DesignIntent, floorBounds: Bounds, scale: number): PlacedRoom[] {
  const c = intent.circulation![0];
  const corridorRect = placeCorridor(c, floorBounds, scale);
  const corridorBoundary = rectOf(corridorRect);
  const [sideA, sideB] = corridorSides(corridorRect, c.orientation, floorBounds);
  const fallback = defaultArea(intent.rooms);
  const corridorRoom: RoomIntent = { id: c.id, usage: c.usage, area: {}, privacy: 'public' };
  const epsArea = (1e-6 * scale) ** 2;
  const doors = intent.doors ?? [];
  const reference = { id: c.id, boundary: corridorBoundary };

  let placed: PlacedRoom[];
  if (rectArea(sideA) < epsArea) {
    placed = layoutFill(intent.rooms, rectOf(sideB), floorBounds, fallback, scale, intent.adjacencies, doors, [reference]);
  } else if (rectArea(sideB) < epsArea) {
    placed = layoutFill(intent.rooms, rectOf(sideA), floorBounds, fallback, scale, intent.adjacencies, doors, [reference]);
  } else {
    const { aRooms, bRooms } = splitRooms(intent.rooms, c.orientation);
    placed = [
      ...layoutFill(aRooms, rectOf(sideA), floorBounds, fallback, scale, intent.adjacencies, doors, [reference]),
      ...layoutFill(bRooms, rectOf(sideB), floorBounds, fallback, scale, intent.adjacencies, doors, [reference]),
    ];
  }
  return [...placed, { room: corridorRoom, boundary: corridorBoundary }];
}

function isOnSide(seg: [Vec2, Vec2], dir: Cardinal, b: Bounds, eps: number): boolean {
  if (dir === 'south') return Math.abs(seg[0][1] - b.minY) < eps && Math.abs(seg[1][1] - b.minY) < eps;
  if (dir === 'north') return Math.abs(seg[0][1] - b.maxY) < eps && Math.abs(seg[1][1] - b.maxY) < eps;
  if (dir === 'east') return Math.abs(seg[0][0] - b.maxX) < eps && Math.abs(seg[1][0] - b.maxX) < eps;
  return Math.abs(seg[0][0] - b.minX) < eps && Math.abs(seg[1][0] - b.minX) < eps;
}

/** 朝向外墙的房间在外墙段开窗（朝向意图的采光兑现）。 */
function exteriorWindows(
  windowIntents: WindowIntent[],
  placed: PlacedRoom[],
  floor: Vec2[],
  floorBounds: Bounds,
  scale: number,
): { boundaries: LayoutBoundarySpec[]; openings: LayoutOpeningSpec[]; windows: LayoutWindowSpec[]; warnings: string[] } {
  const eps = 1e-6 * scale;
  const boundaries: LayoutBoundarySpec[] = [];
  const openings: LayoutOpeningSpec[] = [];
  const windows: LayoutWindowSpec[] = [];
  const warnings: string[] = [];
  const boundaryByKey = new Map<string, string>();

  for (const win of windowIntents) {
    const p = placed.find((x) => x.room.id === win.spaceId);
    if (!p) {
      warnings.push(`窗引用了不存在的空间 ${win.spaceId}`);
      continue;
    }
    const dir = cardinal(win.orientation);
    const sideSegs = sharedSegments(p.boundary, floor).filter((seg) => isOnSide(seg, dir, floorBounds, eps));
    if (!sideSegs.length) {
      warnings.push(`空间 ${win.spaceId} 无 ${dir} 向外墙，跳过窗`);
      continue;
    }
    const seg = sideSegs.reduce((best, s) => (segLength(s) > segLength(best) ? s : best));
    const length = segLength(seg);
    const width = win.width * scale;
    const height = win.height * scale;
    const sill = (win.sillHeight ?? 0.9) * scale;
    if (width > length) {
      warnings.push(`空间 ${win.spaceId} 窗宽 ${win.width} m 超过外墙段 ${(length / scale).toFixed(2)} m`);
      continue;
    }
    const ratio = win.position === 'start' ? 0.25 : win.position === 'end' ? 0.75 : 0.5;
    const position = length * ratio;
    const n = windows.length + 1;
    const key = `${win.spaceId}|${dir}`;
    let boundaryId = boundaryByKey.get(key);
    if (!boundaryId) {
      boundaryId = `ext-${win.spaceId}-${n}`;
      boundaries.push({ id: boundaryId, segment: seg, kind: 'wall', leftSpaceId: 'outside', rightSpaceId: win.spaceId });
      boundaryByKey.set(key, boundaryId);
    }
    const openingId = `win-op-${win.spaceId}-${n}`;
    openings.push({ id: openingId, hostBoundaryId: boundaryId, position, width, height, sillHeight: sill });
    windows.push({ id: `window-${win.spaceId}-${n}`, openingId });
  }
  return { boundaries, openings, windows, warnings };
}

/** 从意图反推外轮廓矩形：房间面积之和 + 20% 缓冲（覆盖走廊与墙体占位）。 */
export function deriveOutline(intent: DesignIntent): { boundary: Vec2[]; bbox: { width: number; height: number; area: number } } {
  const roomArea = intent.rooms.reduce((s, r) => s + (r.area.target ?? r.area.min ?? 10), 0);
  const totalArea = Math.max(roomArea * 1.2, 9);
  const circ = intent.circulation?.[0];
  const aspect = circ?.orientation === 'vertical' ? 3 / 4 : 4 / 3;
  const W = Math.sqrt(totalArea * aspect);
  const H = W / aspect;
  const rw = Math.max(3, Math.round(W * 2) / 2);
  const rh = Math.max(3, Math.round(H * 2) / 2);
  return { boundary: [[0, 0], [rw, 0], [rw, rh], [0, rh], [0, 0]], bbox: { width: rw, height: rh, area: rw * rh } };
}

/** 布局器：把无几何的意图编译成带坐标的 LayoutPlanV2（非矩形房间）。 */
export function layoutFromIntent(intent: DesignIntent, ctx: LayoutContext): IntentLayoutOutput {
  const scale = ctx.units === 'mm' ? 1000 : 1;
  const floor = closePolygon(ctx.floor.boundary, 0);
  const floorBounds = boundsOf(floor);
  if (!floorBounds) throw new Error('外轮廓无法计算包围盒');

  const warnings: string[] = [];
  const fallback = defaultArea(intent.rooms);

  // 房间朝向并入窗户朝向：有北窗的房间应贴北边，否则窗无法落地。
  const winOrient = new Map<string, Cardinal[]>();
  for (const win of intent.windows ?? []) {
    const c = cardinal(win.orientation);
    const list = winOrient.get(win.spaceId) ?? [];
    if (!list.includes(c)) list.push(c);
    winOrient.set(win.spaceId, list);
  }
  const layoutRooms = intent.rooms.map((room) => {
    const extra = winOrient.get(room.id);
    if (!extra?.length) return room;
    const existing = (room.orientation ?? []).map(cardinal).filter((c) => !extra.includes(c));
    return { ...room, orientation: [...extra, ...existing] };
  });

  let placed: PlacedRoom[];
  if (intent.circulation?.length) {
    placed = layoutWithCirculation({ ...intent, rooms: layoutRooms }, floorBounds, scale);
  } else if (isRectangular(floor)) {
    placed = partitionRooms(layoutRooms, { x0: floorBounds.minX, y0: floorBounds.minY, x1: floorBounds.maxX, y1: floorBounds.maxY }, intent.adjacencies)
      .map(({ room, rect }) => ({ room, boundary: rectToRing(rect) }));
  } else {
    // 非矩形外轮廓（异形 program outline）回退：cell 切分 + 吃单元。
    const cellRings = overPartition(floor, Math.max(layoutRooms.length * 2, 2));
    const cells = buildCells(cellRings, floorBounds, scale);
    placed = assignRooms(layoutRooms, cells, intent.adjacencies, intent.doors ?? [], []);
  }

  const openId = intent.circulation?.[0]?.id ?? intent.rooms.find((room) => room.privacy === 'public')?.id ?? intent.rooms[0].id;

  const spaces: LayoutSpaceSpec[] = placed.map((p) => {
    const areaM2 = polygonArea(p.boundary) / scale ** 2;
    if (p.room.area.min !== undefined && areaM2 + 1e-6 < p.room.area.min) {
      warnings.push(`${p.room.usage} 实际 ${areaM2.toFixed(2)} m²，低于下限 ${p.room.area.min} m²`);
    }
    return {
      id: p.room.id,
      usage: p.room.usage,
      enclosed: p.room.id !== openId,
      boundary: p.boundary,
      targetArea: p.room.area.target,
      minArea: p.room.area.min,
    };
  });

  const boundaries: LayoutBoundarySpec[] = [];
  const sharedByPair = new Map<string, LayoutBoundarySpec[]>();
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const pairKey = [placed[i].room.id, placed[j].room.id].sort().join('|');
      for (const seg of sharedSegments(placed[i].boundary, placed[j].boundary)) {
        const id = `split-${boundaries.length + 1}`;
        const boundary: LayoutBoundarySpec = { id, segment: seg, kind: 'wall', leftSpaceId: placed[i].room.id, rightSpaceId: placed[j].room.id };
        boundaries.push(boundary);
        if (!sharedByPair.has(pairKey)) sharedByPair.set(pairKey, []);
        sharedByPair.get(pairKey)!.push(boundary);
      }
    }
  }

  const openings: LayoutOpeningSpec[] = [];
  const doors: LayoutDoorSpec[] = [];
  for (const d of intent.doors ?? []) {
    const pairKey = [...d.connects].sort().join('|');
    const pairBoundaries = sharedByPair.get(pairKey) ?? [];
    if (!pairBoundaries.length) {
      warnings.push(`${d.connects[0]}↔${d.connects[1]} 不相邻，无法开门`);
      continue;
    }
    const boundary = pairBoundaries[0];
    const length = segLength(boundary.segment);
    const width = d.width * scale;
    const height = d.height * scale;
    if (width > length) {
      warnings.push(`门 ${d.connects[0]}↔${d.connects[1]} 宽 ${d.width} m 超过共享边 ${(length / scale).toFixed(2)} m`);
      continue;
    }
    const ratio = d.position === 'start' ? 0.25 : d.position === 'end' ? 0.75 : 0.5;
    const position = length * ratio;
    const openingId = `op-${boundary.id}`;
    const doorId = `door-${boundary.id}`;
    openings.push({ id: openingId, hostBoundaryId: boundary.id, position, width, height, sillHeight: 0 });
    doors.push({
      id: doorId,
      openingId,
      swing: d.swing ?? 'left',
      ...(d.leafCount !== undefined ? { leafCount: d.leafCount } : {}),
      connects: d.connects,
    });
  }

  const ext = exteriorWindows(intent.windows ?? [], placed, floor, floorBounds, scale);
  warnings.push(...ext.warnings);

  const sharedPairs = new Set(boundaries.map((bd) => [bd.leftSpaceId, bd.rightSpaceId].sort().join('|')));
  for (const adj of intent.adjacencies) {
    if (adj.relation !== 'adjacent') continue;
    if (!sharedPairs.has([adj.a, adj.b].sort().join('|'))) {
      warnings.push(`adjacent ${adj.a}-${adj.b} 未兑现（被分隔）`);
    }
  }

  const unmet = [...intent.unmetRequirements];
  const nonAdjacent = intent.adjacencies.filter((adj) => adj.relation !== 'adjacent');
  if (nonAdjacent.length) {
    unmet.push(`near/separated 邻接暂未兑现：${nonAdjacent.map((adj) => `${adj.a}-${adj.b}`).join('、')}`);
  }

  return {
    plan: {
      schemaVersion: 2,
      spaces,
      boundaries: [...boundaries, ...ext.boundaries],
      openings: [...openings, ...ext.openings],
      doors,
      windows: ext.windows,
      assumptions: intent.assumptions,
      unmetRequirements: unmet,
      ...(intent.building?.wallHeight !== undefined ? { floorHeight: intent.building.wallHeight } : {}),
      ...(intent.building?.wallThickness !== undefined ? { wallThickness: intent.building.wallThickness } : {}),
    },
    warnings,
  };
}

/** 意图 → model.json 的端到端入口。 */
export function compileIntent(
  intent: DesignIntent,
  ctx: LayoutContext,
  revisionId: string,
  requireFullCoverage = false,
): { model: SpaceModel; warnings: string[]; assumptions: string[] } {
  const { plan, warnings } = layoutFromIntent(intent, ctx);
  const result = compileLayoutPlan(plan, ctx, revisionId, requireFullCoverage);
  return { model: result.model, warnings: [...warnings, ...result.warnings], assumptions: result.assumptions };
}
