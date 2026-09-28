import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesignIntent } from '../src/design/intent';
import { createLayoutContext } from '../src/design/layoutContext';
import { compileIntent } from '../src/design/layoutIntent';
import { polygonArea } from '../src/model/geometry';
import { sharedSegments } from '../src/design/regionGeometry';

function outline(width: number, height: number): string {
  return JSON.stringify({ boundary: [[0, 0], [width, 0], [width, height], [0, height], [0, 0]], origin: [0, 0], units: 'm' });
}

const intentRaw = {
  schemaVersion: 1,
  rooms: [
    { id: 'living', usage: '客厅', area: { min: 20, target: 30 }, privacy: 'public' },
    { id: 'bed', usage: '卧室', area: { min: 10, target: 15 } },
    { id: 'kitchen', usage: '厨房', area: { min: 6, target: 10 } },
  ],
  adjacencies: [
    { a: 'living', b: 'bed', relation: 'adjacent' },
    { a: 'bed', b: 'kitchen', relation: 'adjacent' },
  ],
  doors: [
    { connects: ['living', 'bed'], width: 0.9, height: 2.1 },
    { connects: ['bed', 'kitchen'], width: 0.9, height: 2.1 },
  ],
  daylight: [{ roomIds: ['living'], minHours: 3 }],
  assumptions: [],
  unmetRequirements: [],
};

test('compileIntent 把意图编译成 model（端到端）', () => {
  const parsed = parseDesignIntent(intentRaw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const ctx = createLayoutContext(outline(10, 8));
  const { model, warnings } = compileIntent(parsed.intent, ctx, 'rev-intent');

  assert.equal(model.spaces.length, 3);
  assert.ok(model.openings.length >= 2, `openings=${model.openings.length}`);
  assert.ok(model.doors.length >= 2, `doors=${model.doors.length}`);
  assert.ok(model.walls.length >= 6, `walls=${model.walls.length}`);
  assert.deepEqual(model.spaces.map((s) => s.id).sort(), ['bed', 'kitchen', 'living']);
  assert.equal(model.model.revisionId, 'rev-intent');

  // 每个房间面积不低于 min
  for (const space of model.spaces) {
    const area = polygonArea(space.boundary);
    const spec = (parsed.intent.rooms as typeof intentRaw.rooms).find((r) => r.id === space.id);
    assert.ok(area >= (spec?.area.min ?? 0) - 1e-6, `${space.id} 面积 ${area} 低于下限`);
  }
  assert.ok(warnings.every((w) => typeof w === 'string'));
});

test('compileIntent 兑现朝向：朝南贴 minY、朝北贴 maxY、朝东贴 maxX、朝西贴 minX', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 30 }, orientation: ['south'], privacy: 'public' },
      { id: 'bed', usage: '卧室', area: { target: 15 }, orientation: ['north'] },
      { id: 'study', usage: '书房', area: { target: 10 }, orientation: ['east'] },
      { id: 'bath', usage: '卫生间', area: { target: 5 }, orientation: ['west'] },
    ],
    doors: [
      { connects: ['living', 'study'], width: 0.9, height: 2.1 },
      { connects: ['living', 'bath'], width: 0.9, height: 2.1 },
      { connects: ['living', 'bed'], width: 0.9, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-orient');
  const byId = new Map(model.spaces.map((s) => [s.id, s]));
  const touches = (id: string, coord: number, axis: 0 | 1) =>
    (byId.get(id)?.boundary ?? []).some((p) => Math.abs(p[axis] - coord) < 1e-6);

  assert.ok(touches('living', 0, 1), '客厅应贴南边 minY=0');
  assert.ok(touches('bed', 8, 1), '卧室应贴北边 maxY=8');
  assert.ok(touches('study', 10, 0), '书房应贴东边 maxX=10');
  assert.ok(touches('bath', 0, 0), '卫生间应贴西边 minX=0');
});

test('compileIntent 按 windows 清单开窗', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 30 }, privacy: 'public' },
      { id: 'bed', usage: '卧室', area: { target: 15 } },
      { id: 'kitchen', usage: '厨房', area: { target: 10 } },
    ],
    windows: [
      { spaceId: 'living', orientation: 'south', width: 1.8, height: 2.0, sillHeight: 0.9 },
      { spaceId: 'bed', orientation: 'north', width: 1.2, height: 1.5 },
    ],
    doors: [
      { connects: ['living', 'bed'], width: 0.9, height: 2.1 },
      { connects: ['living', 'kitchen'], width: 0.9, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-win');
  assert.equal(model.windows.length, 2, `windows=${model.windows.length}`);
  const livingWin = model.windows.find((w) => w.id.startsWith('window-living'));
  const bedWin = model.windows.find((w) => w.id.startsWith('window-bed'));
  assert.ok(livingWin && bedWin);
  const livingOp = model.openings.find((o) => o.id === livingWin.openingId);
  const bedOp = model.openings.find((o) => o.id === bedWin.openingId);
  assert.ok(livingOp && bedOp);
  assert.equal(livingOp.width, 1.8, '客厅窗宽应为 1.8');
  assert.equal(livingOp.height, 2.0, '客厅窗高应为 2.0');
  assert.equal(livingOp.sillHeight, 0.9, '客厅窗台应为 0.9');
  assert.equal(bedOp.width, 1.2, '卧室窗宽应为 1.2');
  assert.equal(bedOp.sillHeight, 0.9, '卧室窗台默认 0.9');
  assert.ok(livingOp.hostWallId, '窗应有宿主墙（外墙）');
});

test('compileIntent 落地窗与多扇窗清单', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 30 }, privacy: 'public' },
    ],
    windows: [
      { spaceId: 'living', orientation: 'south', width: 1.5, height: 2.4, sillHeight: 0, position: 'start' },
      { spaceId: 'living', orientation: 'south', width: 1.5, height: 2.4, sillHeight: 0, position: 'end' },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-win2');
  assert.equal(model.windows.length, 2, '两条 windows 应有 2 扇窗');
  for (const w of model.windows) {
    const op = model.openings.find((o) => o.id === w.openingId);
    assert.ok(op);
    assert.equal(op.sillHeight, 0, '落地窗窗台应为 0');
  }
  const positions = model.windows.map((w) => model.openings.find((o) => o.id === w.openingId)!.position).sort((a, b) => a - b);
  assert.ok(positions[0] < positions[1], 'start 位置的窗应在 end 之前');
});

test('compileIntent 支持 L 形外轮廓', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 25 }, orientation: ['south'], privacy: 'public' },
      { id: 'bed', usage: '卧室', area: { target: 12 }, orientation: ['north'] },
      { id: 'kitchen', usage: '厨房', area: { target: 8 } },
    ],
    doors: [
      { connects: ['living', 'bed'], width: 0.9, height: 2.1 },
      { connects: ['living', 'kitchen'], width: 0.9, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const lShape = JSON.stringify({ boundary: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 8], [0, 8], [0, 0]], origin: [0, 0], units: 'm' });
  const ctx = createLayoutContext(lShape);
  const { model } = compileIntent(parsed.intent, ctx, 'rev-l');
  assert.equal(model.spaces.length, 3);
  const byId = new Map(model.spaces.map((s) => [s.id, s]));
  const touchesY = (id: string, y: number) => (byId.get(id)?.boundary ?? []).some((p) => Math.abs(p[1] - y) < 1e-6);
  assert.ok(touchesY('living', 0), '客厅应贴南边 minY=0');
  assert.ok(touchesY('bed', 8), '卧室应贴北边 maxY=8');
});

test('compileIntent 产出 L 形合并房间', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 45 }, orientation: ['south'], privacy: 'public' },
      { id: 'bed', usage: '卧室', area: { target: 15 }, orientation: ['north'] },
    ],
    doors: [{ connects: ['living', 'bed'], width: 0.9, height: 2.1 }],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 6));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-lroom');
  const living = model.spaces.find((s) => s.id === 'living');
  assert.ok(living, '应有客厅');
  assert.ok(living.boundary.length - 1 >= 6, `客厅应有 L 形边界（>=6 顶点），实际 ${living.boundary.length - 1}`);
});

test('compileIntent 梯形外轮廓产出贴斜边的房间', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 30 }, privacy: 'public' },
      { id: 'bed', usage: '卧室', area: { target: 15 } },
    ],
    doors: [{ connects: ['living', 'bed'], width: 0.9, height: 2.1 }],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const trap = JSON.stringify({ boundary: [[0, 0], [10, 0], [8, 8], [2, 8], [0, 0]], origin: [0, 0], units: 'm' });
  const ctx = createLayoutContext(trap);
  const { model } = compileIntent(parsed.intent, ctx, 'rev-trap');
  const living = model.spaces.find((s) => s.id === 'living');
  assert.ok(living, '应有客厅');
  const ring = living.boundary.slice(0, -1);
  const hasDiagonal = ring.some((p, i) => {
    const q = ring[(i + 1) % ring.length];
    return Math.abs(p[0] - q[0]) > 1e-6 && Math.abs(p[1] - q[1]) > 1e-6;
  });
  assert.ok(hasDiagonal, '房间应有斜边（贴合梯形轮廓）');
});

test('compileIntent 走廊骨架：corridor 为开放区，房间按朝向分两侧', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    circulation: [{ id: 'corridor', usage: '走廊', orientation: 'horizontal', width: 2 }],
    rooms: [
      { id: 'workspace', usage: '工作区', area: { target: 60 }, orientation: ['south'] },
      { id: 'meeting', usage: '会议室', area: { target: 20 }, orientation: ['north'] },
    ],
    doors: [
      { connects: ['workspace', 'corridor'], width: 0.9, height: 2.1 },
      { connects: ['meeting', 'corridor'], width: 0.9, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(20, 12));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-corridor');
  const corridor = model.spaces.find((s) => s.id === 'corridor');
  assert.ok(corridor, '应有走廊');
  assert.equal(corridor.enclosed, false, '走廊应为开放交通区');
  const workspace = model.spaces.find((s) => s.id === 'workspace');
  assert.ok(workspace, '应有工作区');
  assert.ok(workspace!.boundary.some((p) => Math.abs(p[1]) < 1e-6), '工作区应贴南边 minY=0');
  const meeting = model.spaces.find((s) => s.id === 'meeting');
  assert.ok(meeting, '应有会议室');
  assert.ok(meeting!.boundary.some((p) => Math.abs(p[1] - 12) < 1e-6), '会议室应贴北边 maxY=12');
  assert.ok(model.doors.length >= 2, `应有房间连通走廊的门洞，实际 ${model.doors.length}`);
});

test('compileIntent 靠边走廊（position:start）单侧排布房间', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    circulation: [{ id: 'corridor', usage: '走廊', orientation: 'horizontal', width: 2, position: 'start' }],
    rooms: [
      { id: 'workspace', usage: '工作区', area: { target: 80 } },
      { id: 'meeting', usage: '会议室', area: { target: 20 } },
    ],
    doors: [
      { connects: ['workspace', 'corridor'], width: 0.9, height: 2.1 },
      { connects: ['meeting', 'corridor'], width: 0.9, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(20, 10));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-side');
  const corridor = model.spaces.find((s) => s.id === 'corridor');
  assert.ok(corridor, '应有走廊');
  assert.ok(corridor.boundary.some((p) => Math.abs(p[1]) < 1e-6), '走廊应贴南边 minY=0');
  for (const r of model.spaces.filter((s) => s.id !== 'corridor')) {
    assert.ok(r.boundary.every((p) => p[1] >= 2 - 1e-6), `${r.id} 应在走廊北侧（单侧排布）`);
  }
});

test('compileIntent adjacent 房间聚在一起', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'lobby', usage: '门厅', area: { target: 15 }, privacy: 'public' },
      { id: 'meeting-1', usage: '会议室1', area: { target: 15 } },
      { id: 'meeting-2', usage: '会议室2', area: { target: 15 } },
      { id: 'office', usage: '办公室', area: { target: 12 } },
    ],
    adjacencies: [{ a: 'meeting-1', b: 'meeting-2', relation: 'adjacent' }],
    doors: [
      { connects: ['lobby', 'meeting-1'], width: 0.9, height: 2.1 },
      { connects: ['meeting-1', 'meeting-2'], width: 0.9, height: 2.1 },
      { connects: ['lobby', 'office'], width: 0.9, height: 2.1 },
    ],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(15, 8));
  const { model, warnings } = compileIntent(parsed.intent, ctx, 'rev-adj');
  const m1 = model.spaces.find((s) => s.id === 'meeting-1');
  const m2 = model.spaces.find((s) => s.id === 'meeting-2');
  assert.ok(m1 && m2);
  assert.ok(sharedSegments(m1.boundary, m2.boundary).length > 0, 'meeting-1 和 meeting-2 应相邻');
  assert.ok(!warnings.some((w) => w.includes('adjacent')), 'adjacent 应兑现，无 warning');
});

test('compileIntent separated 房间不相邻', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'lobby', usage: '门厅', area: { target: 15 }, privacy: 'public' },
      { id: 'restroom', usage: '卫生间', area: { target: 10 } },
      { id: 'office', usage: '办公室', area: { target: 12 } },
      { id: 'meeting', usage: '会议室', area: { target: 15 } },
    ],
    adjacencies: [{ a: 'restroom', b: 'office', relation: 'separated' }],
    doors: [
      { connects: ['lobby', 'restroom'], width: 0.9, height: 2.1 },
      { connects: ['lobby', 'office'], width: 0.9, height: 2.1 },
      { connects: ['restroom', 'meeting'], width: 0.9, height: 2.1 },
    ],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(15, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-sep');
  const restroom = model.spaces.find((s) => s.id === 'restroom');
  const office = model.spaces.find((s) => s.id === 'office');
  assert.ok(restroom && office);
  assert.equal(sharedSegments(restroom.boundary, office.boundary).length, 0, 'restroom 和 office 应不相邻');
});

test('compileIntent 按门意图指定门规格', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'lobby', usage: '门厅', area: { target: 15 }, privacy: 'public' },
      { id: 'meeting', usage: '会议室', area: { target: 20 } },
    ],
    doors: [{ connects: ['lobby', 'meeting'], swing: 'right', leafCount: 2, width: 1.5, height: 2.4 }],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-door');
  const door = model.doors.find((d) => d.swing === 'right');
  assert.ok(door, '应有右开门');
  assert.equal(door.leafCount, 2, '应为双开门');
  const op = model.openings.find((o) => o.id === door.openingId);
  assert.ok(op);
  assert.equal(op.width, 1.5, '门宽应为 1.5');
  assert.equal(op.height, 2.4, '门高应为 2.4');
});

test('compileIntent 按窗位置 position 定位', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    rooms: [
      { id: 'living', usage: '客厅', area: { target: 60 }, privacy: 'public' },
    ],
    windows: [
      { spaceId: 'living', orientation: 'south', width: 1.5, height: 1.5, position: 'end' },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-winpos');
  const win = model.windows[0];
  assert.ok(win, '应有窗');
  const op = model.openings.find((o) => o.id === win.openingId);
  assert.ok(op);
  assert.ok(op.position > 5, `窗应靠终点侧（position=${op.position}）`);
});

test('compileIntent 兑现墙厚墙高与门高', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    building: { wallThickness: 0.2, wallHeight: 4 },
    rooms: [
      { id: 'lobby', usage: '门厅', area: { target: 15 }, privacy: 'public' },
      { id: 'meeting', usage: '会议室', area: { target: 20 } },
    ],
    doors: [{ connects: ['lobby', 'meeting'], width: 1.2, height: 2.4 }],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(10, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-dim');
  assert.ok(model.walls.length > 0);
  assert.ok(model.walls.every((w) => w.thickness === 0.2), '墙厚应为 0.2');
  assert.ok(model.walls.every((w) => w.height === 4), '墙高应为 4');
  const door = model.doors[0];
  const doorOp = model.openings.find((o) => o.id === door.openingId);
  assert.ok(doorOp);
  assert.equal(doorOp.width, 1.2, '门宽应为 1.2');
  assert.equal(doorOp.height, 2.4, '门高应为 2.4');
});

test('compileIntent 门 connects 的双方空间相邻（遵循连接关系布局）', () => {
  const parsed = parseDesignIntent({
    schemaVersion: 1,
    circulation: [{ id: 'corridor', usage: '走廊', orientation: 'horizontal', width: 1.8 }],
    rooms: [
      { id: 'open', usage: '开放区', area: { target: 20 }, orientation: ['south'], privacy: 'public' },
      { id: 'a', usage: '房间A', area: { target: 8 }, orientation: ['north'] },
      { id: 'b', usage: '房间B', area: { target: 8 }, orientation: ['north'] },
      { id: 'c', usage: '房间C', area: { target: 8 }, orientation: ['north'] },
    ],
    doors: [
      { connects: ['open', 'corridor'], width: 1.0, height: 2.1 },
      { connects: ['a', 'corridor'], width: 1.0, height: 2.1 },
      { connects: ['b', 'corridor'], width: 1.0, height: 2.1 },
      { connects: ['c', 'corridor'], width: 1.0, height: 2.1 },
    ],
    adjacencies: [],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const ctx = createLayoutContext(outline(13, 8));
  const { model } = compileIntent(parsed.intent, ctx, 'rev-doorconn');
  for (const d of parsed.intent.doors!) {
    const a = model.spaces.find((s) => s.id === d.connects[0]);
    const b = model.spaces.find((s) => s.id === d.connects[1]);
    assert.ok(a && b, `${d.connects[0]} 或 ${d.connects[1]} 不存在`);
    assert.ok(sharedSegments(a.boundary, b.boundary).length > 0, `${d.connects[0]}↔${d.connects[1]} 应相邻`);
  }
});
