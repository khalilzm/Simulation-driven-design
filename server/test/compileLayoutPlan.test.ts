import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlineJson, buildSpacePrompt, outlineToText } from '../src/spacePrompt';
import { createLayoutContext } from '../src/design/layoutContext';
import { compileLayoutPlan } from '../src/design/compileLayoutPlan';
import { compileLayout } from '../src/design/compileLayout';
import { validateStoredDesign } from '../src/model/designValidity';
import { layoutModel, rectangle } from './helpers/spaceModel';
import type { LayoutPlanV2 } from '../src/design/layoutPlanTypes';
import type { SpaceModel } from '@sdd/shared';
import { pointAlongWallPolyline } from '../src/model/geometry';
import { segmentOverlap } from '../src/design/regionGeometry';

function catalog() {
  const model = layoutModel();
  return createLayoutContext(buildOutlineJson({
    boundary: model.floor.boundary,
    origin: model.model.origin,
    bbox: { width: 10, height: 8, area: 80 },
  }));
}

test('v2 开放空间铺满轮廓，外轮廓自动生成墙', () => {
  const { model } = compileLayoutPlan({
    schemaVersion: 2,
    spaces: [{ id: 'training', usage: '训练区', enclosed: false, boundary: rectangle(0, 0, 10, 8).slice(0, -1) }],
    assumptions: [],
    unmetRequirements: [],
  }, catalog(), 'rev-0001', true);
  assert.equal(model.spaces.length, 1);
  assert.ok(model.walls.length >= 4);
  assert.equal(validateStoredDesign(model).valid, true);
});

test('v2 space 略超出固定轮廓时自动裁切并警告，不整案失败', () => {
  const { model, warnings } = compileLayoutPlan({
    schemaVersion: 2,
    spaces: [{ id: 'meeting', usage: '会议', enclosed: false, boundary: [[0, 0], [10.2, 0], [10.2, 8], [0, 8]] }],
    assumptions: [],
    unmetRequirements: [],
  }, catalog(), 'rev-0010', true);
  assert.equal(validateStoredDesign(model).valid, true);
  assert.ok(warnings.some((item) => item.includes('meeting') && item.includes('裁切')));
  assert.ok(model.spaces[0].boundary.every((point) => point[0] <= 10 + 1e-3));
});

test('v2 切分房间与走廊，共享边生墙且可装门', () => {
  const { model } = compileLayoutPlan({
    schemaVersion: 2,
    spaces: [
      { id: 'corridor', usage: '走廊', enclosed: false, boundary: [[0, 0], [3, 0], [3, 8], [0, 8]] },
      { id: 'studio', usage: '团操室', enclosed: true, boundary: [[3, 0], [10, 0], [10, 8], [3, 8]] },
    ],
    boundaries: [{
      id: 'b-corridor-studio',
      segment: [[3, 0], [3, 8]],
      kind: 'wall',
      leftSpaceId: 'corridor',
      rightSpaceId: 'studio',
    }],
    openings: [{
      id: 'door-opening',
      hostBoundaryId: 'b-corridor-studio',
      position: 4,
      width: 1,
      height: 2.1,
    }],
    doors: [{
      id: 'door-1',
      openingId: 'door-opening',
      swing: 'left',
      connects: ['corridor', 'studio'],
    }],
    assumptions: [],
    unmetRequirements: [],
  }, catalog(), 'rev-0002', true);
  assert.equal(model.doors.length, 1);
  assert.equal(model.openings.length, 1);
  assert.ok(model.walls.some((wall) => wall.id === 'wall-b-corridor-studio' || wall.id.startsWith('layout-wall')));
  assert.equal(validateStoredDesign(model).valid, true);
});

test('v2 共享边带浮点偏移时只生成一条墙', () => {
  const off = 2e-7;
  const { model } = compileLayoutPlan({
    schemaVersion: 2,
    spaces: [
      { id: 'a', usage: 'A', enclosed: true, boundary: [[0, 0], [5, 0], [5, 8], [0, 8]] },
      { id: 'b', usage: 'B', enclosed: true, boundary: [[5 + off, 0], [10, 0], [10, 8], [5 + off, 8]] },
    ],
    assumptions: [],
    unmetRequirements: [],
  }, catalog(), 'rev-0001', true);
  const onSplitLine = model.walls.filter((wall) => wall.geometry.points.every((p) => Math.abs(p[0] - 5) < 1e-4));
  assert.equal(onSplitLine.length, 1, '共享边应只生成一条墙，而不是两条近乎重合的墙');
  assert.equal(validateStoredDesign(model).valid, true);
});

test('compileLayout 仅接受 schemaVersion 2', () => {
  const cat = catalog();
  assert.throws(() => compileLayout({ allocations: [{ id: 'training', usage: '训练区', regionIds: ['r1'], enclosed: false }] }, cat, 'rev-1'), /不再支持 allocations/);
  const { model } = compileLayout({ schemaVersion: 2, spaces: [{ id: 'training', usage: '训练区', enclosed: false, boundary: rectangle(0, 0, 10, 8).slice(0, -1) }], assumptions: [], unmetRequirements: [] }, cat, 'rev-0002', true);
  assert.equal(model.spaces.length, 1);
});

test('v2 门宽超出墙段时报错', () => {
  assert.throws(() => compileLayoutPlan({
    schemaVersion: 2,
    spaces: [
      { id: 'a', usage: 'A', enclosed: false, boundary: [[0, 0], [5, 0], [5, 8], [0, 8]] },
      { id: 'b', usage: 'B', enclosed: true, boundary: [[5, 0], [10, 0], [10, 8], [5, 8]] },
    ],
    boundaries: [{ id: 'split', segment: [[5, 0], [5, 8]], kind: 'wall', leftSpaceId: 'a', rightSpaceId: 'b' }],
    openings: [{ id: 'o1', hostBoundaryId: 'split', position: 4, width: 9, height: 2.1 }],
    assumptions: [],
    unmetRequirements: [],
  }, catalog(), 'rev-0003'), /超出墙/);
});

function roomPlan(x = 3): LayoutPlanV2 {
  return {
    schemaVersion: 2,
    spaces: [
      { id: 'hall', usage: '门厅', enclosed: false, boundary: rectangle(0, 0, x, 8) },
      { id: 'studio', usage: '团操室', enclosed: true, boundary: rectangle(x, 0, 10, 8) },
    ],
    boundaries: [{ id: 'split', segment: [[x, 0], [x, 8]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'studio' }],
    openings: [{ id: 'o1', hostBoundaryId: 'split', position: 1, width: 1, height: 2.1 }],
    doors: [{ id: 'd1', openingId: 'o1', swing: 'left', connects: ['hall', 'studio'] }],
    assumptions: [], unmetRequirements: [],
  };
}

test('v2 洞口语义位置 position:"center" 落到边界中点', () => {
  const plan = roomPlan();
  (plan.openings![0] as { position: unknown }).position = 'center';
  const { model } = compileLayoutPlan(plan, catalog(), 'rev-0001', true);
  const opening = model.openings[0];
  const wall = model.walls.find((w) => w.id === opening.hostWallId)!;
  const p = pointAlongWallPolyline(wall.geometry.points, opening.position)!;
  assert.ok(Math.abs(p[0] - 3) < 1e-6 && Math.abs(p[1] - 4) < 1e-6, `洞口中心应为 (3,4)，实际 (${p})`);
});

test('v2 doors.swing inward/outward 解析为 left/right', () => {
  const raw = { ...roomPlan(), doors: [{ id: 'd1', openingId: 'o1', swing: 'inward', connects: ['hall', 'studio'] }] };
  const { model } = compileLayout(raw, catalog(), 'rev-0001', true);
  assert.equal(model.doors[0].swing, 'left');
  raw.doors[0].swing = 'outward';
  const { model: outward } = compileLayout(raw, catalog(), 'rev-0002', true);
  assert.equal(outward.doors[0].swing, 'right');
});

function fromParent(parent: SpaceModel) {
  return createLayoutContext(outlineToText(parent), parent);
}

function fixedPartition(points: [number, number][] = [[3, 0], [3, 8]]) {
  const parent = layoutModel();
  parent.walls.push({ id: 'existing-partition', geometry: { type: 'polyline', points }, fixed: true, height: 3, thickness: 0.12 });
  return parent;
}

test('v2 T 形邻接的局部开放边界不会被整边补墙', () => {
  const plan = roomPlan(5);
  plan.spaces = [
    { id: 'studio', usage: '团操室', enclosed: true, boundary: rectangle(0, 0, 5, 8) },
    { id: 'hall', usage: '门厅', enclosed: false, boundary: rectangle(5, 0, 10, 4) },
    { id: 'rest', usage: '休息区', enclosed: false, boundary: rectangle(5, 4, 10, 8) },
  ];
  plan.boundaries = [{ id: 'open-hall', segment: [[5, 0], [5, 4]], kind: 'open', leftSpaceId: 'hall', rightSpaceId: 'studio' }];
  plan.openings = []; plan.doors = [];
  const { model } = compileLayoutPlan(plan, catalog(), 'rev-0001', true);
  assert.equal(model.walls.some((wall) => segmentOverlap([5, 0], [5, 4], ...wall.geometry.points as [[number, number], [number, number]])), false);
  assert.ok(model.walls.some((wall) => segmentOverlap([5, 4], [5, 8], ...wall.geometry.points as [[number, number], [number, number]])));
  assert.equal(validateStoredDesign(model).valid, true);
});

test('v2 允许在同一共享长边上只声明一段开放边界', () => {
  const plan = roomPlan();
  plan.boundaries![0].segment = [[3, 2], [3, 4]];
  plan.boundaries![0].kind = 'open'; plan.openings = []; plan.doors = [];
  const { model } = compileLayoutPlan(plan, catalog(), 'rev-0001', true);
  assert.equal(model.walls.some((wall) => segmentOverlap([3, 2], [3, 4], ...wall.geometry.points as [[number, number], [number, number]])), false);
  assert.equal(model.walls.filter((wall) => wall.geometry.points.every((p) => p[0] === 3)).length, 2);
});

test('v2 反向边界换算洞口坐标，并包含宿主折线前段长度', () => {
  const plan = roomPlan();
  plan.boundaries![0].segment.reverse();
  const { model } = compileLayoutPlan(plan, fromParent(fixedPartition([[0, 0], [3, 0], [3, 8]])), 'rev-0002', true);
  const opening = model.openings[0];
  const wall = model.walls.find((item) => item.id === opening.hostWallId)!;
  assert.equal(opening.position, 10);
  assert.deepEqual(pointAlongWallPolyline(wall.geometry.points, opening.position), [3, 7]);
});

test('v2 局部边界洞口定位到长墙的正确区间', () => {
  const plan = roomPlan(); plan.boundaries![0].segment = [[3, 4], [3, 8]];
  const { model } = compileLayoutPlan(plan, fromParent(fixedPartition()), 'rev-0002', true);
  assert.equal(model.openings[0].position, 5);
  assert.equal(model.openings[0].hostWallId, 'existing-partition');
});

test('v2 共享边由多条墙覆盖时按洞口位置选择墙，跨接缝则明确拒绝', () => {
  const parent = fixedPartition([[3, 0], [3, 4]]);
  parent.walls.push({ ...parent.walls.at(-1)!, id: 'upper-wall', geometry: { type: 'polyline', points: [[3, 4], [3, 8]] } });
  const plan = roomPlan(); plan.openings![0].position = 6;
  const { model } = compileLayoutPlan(plan, fromParent(parent), 'rev-0002', true);
  assert.equal(model.openings[0].hostWallId, 'upper-wall');
  assert.equal(model.openings[0].position, 2);
  plan.openings![0].position = 4;
  assert.throws(() => compileLayoutPlan(plan, fromParent(parent), 'rev-0002'), /墙段接缝/);
});

test('v2 首轮可用 outside 外边界创建入口和外窗，不依赖生成墙 ID', () => {
  const plan = roomPlan();
  plan.boundaries!.push(
    { id: 'entry', segment: [[0, 0], [3, 0]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'outside' },
    { id: 'south-window', segment: [[3, 0], [10, 0]], kind: 'wall', leftSpaceId: 'studio', rightSpaceId: 'outside' },
  );
  plan.openings!.push(
    { id: 'entry-opening', hostBoundaryId: 'entry', position: 1.5, width: 1, height: 2.1 },
    { id: 'window-opening', hostBoundaryId: 'south-window', position: 3, width: 2, height: 1.2, sillHeight: 0.9 },
  );
  plan.doors!.push({ id: 'entry-door', openingId: 'entry-opening', swing: 'left', connects: ['outside', 'hall'] });
  plan.windows = [{ id: 'window-1', openingId: 'window-opening' }];
  const { model, warnings } = compileLayoutPlan(plan, catalog(), 'rev-0001', true);
  assert.equal(validateStoredDesign(model).valid, true);
  assert.equal(warnings.length, 0);
  assert.ok(Math.abs(model.openings.find((item) => item.id === 'window-opening')!.position - 6) < 0.01);
  assert.equal(model.openings.find((item) => item.id === 'window-opening')!.sillHeight, 0.9);
  plan.doors!.at(-1)!.connects = ['hall', 'studio'];
  assert.throws(() => compileLayoutPlan(plan, catalog(), 'rev-0001'), /connects/);
  const invalid = roomPlan();
  invalid.boundaries!.push(
    { id: 'bad-split', segment: [[1, 1], [2, 2]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'studio' },
  );
  assert.throws(() => compileLayoutPlan(invalid, catalog(), 'rev-0001'), /共享边/);
});

test('v2 带门隔墙下一轮可移动并复用构件 ID，父模型保持原样', () => {
  const first = compileLayoutPlan(roomPlan(), catalog(), 'rev-0001', true).model;
  const saved = JSON.stringify(first);
  const { model } = compileLayoutPlan(roomPlan(4), fromParent(first), 'rev-0002', true);
  assert.equal(model.openings.length, 1);
  assert.equal(model.openings[0].id, 'o1');
  assert.equal(model.walls.some((wall) => wall.geometry.points.every((p) => p[0] === 3)), false);
  assert.deepEqual(model.walls.find((wall) => wall.id === model.openings[0].hostWallId)!.geometry.points, [[4, 0], [4, 8]]);
  assert.equal(JSON.stringify(first), saved);
  const next = roomPlan(4); next.boundaries![0].kind = 'open'; next.openings = []; next.doors = [];
  const deleted = compileLayoutPlan(next, fromParent(model), 'rev-0003', true).model;
  assert.equal(deleted.openings.length, 0);
  assert.equal(deleted.doors.length, 0);
});

test('v2 仍保留既有洞口和宿主墙，也尊重用户固定的生成墙', () => {
  const parent = layoutModel();
  parent.openings = [{ id: 'existing-entry', hostWallId: 'wall-0', position: 1, width: 1, height: 2.1 }];
  parent.doors = [{ id: 'existing-door', openingId: 'existing-entry', swing: 'left', analysisProperties: {} }];
  const { model } = compileLayoutPlan(roomPlan(), fromParent(parent), 'rev-0002', true);
  assert.deepEqual(model.openings.find((item) => item.id === 'existing-entry'), parent.openings[0]);
  assert.deepEqual(model.walls.find((item) => item.id === 'wall-0'), parent.walls[0]);
  const generated = model.walls.find((wall) => wall.id === 'wall-split')!; generated.fixed = true;
  assert.throws(() => compileLayoutPlan(roomPlan(2), fromParent(model), 'rev-0003'), /跨越保留墙/);
});

test('v2 无门的封闭空间与只互通无出口的空间组产生不可达警告', () => {
  const plan = roomPlan(); plan.openings = []; plan.doors = [];
  assert.match(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.join(), /studio 不可达/);
  const connected = roomPlan(); connected.spaces[0].enclosed = true;
  assert.match(compileLayoutPlan(connected, catalog(), 'rev-0001').warnings.join(), /不可达/);
  plan.openings = [{ id: 'window', hostBoundaryId: 'split', position: 1, width: 1, height: 1.2, sillHeight: 0.9 }];
  plan.windows = [{ id: 'w1', openingId: 'window' }];
  assert.match(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.join(), /studio 不可达/);
});

test('v2 纯落地洞口可通行，未确定入口时有明确提示', () => {
  const plan = roomPlan(); plan.doors = [];
  assert.match(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.join(), /尚未确定室外入口/);
  plan.openings![0].sillHeight = 0.3;
  assert.match(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.join(), /不可达/);
});

test('v2 已确定入口时也检查开放空间的可达性', () => {
  const plan = roomPlan();
  plan.spaces[1].boundary = rectangle(3, 0, 10, 4);
  plan.spaces.push({ id: 'rest', usage: '休息区', enclosed: false, boundary: rectangle(3, 4, 10, 8) });
  plan.boundaries![0].segment = [[3, 0], [3, 4]];
  plan.boundaries!.push(
    { id: 'upper', segment: [[3, 4], [3, 8]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'rest' },
    { id: 'entry', segment: [[0, 0], [3, 0]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'outside' },
  );
  plan.openings!.push({ id: 'entry-opening', hostBoundaryId: 'entry', position: 1.5, width: 1, height: 2.1 });
  plan.doors!.push({ id: 'entry-door', openingId: 'entry-opening', swing: 'left', connects: ['hall', 'outside'] });
  assert.match(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.join(), /rest 不可达/);
  plan.openings!.push({ id: 'rest-opening', hostBoundaryId: 'upper', position: 2, width: 1, height: 2.1 });
  plan.doors!.push({ id: 'rest-door', openingId: 'rest-opening', swing: 'left', connects: ['hall', 'rest'] });
  assert.equal(compileLayoutPlan(plan, catalog(), 'rev-0001').warnings.length, 0);
});

test('v2 生成窗可用同 ID 修改窗位和窗台，也可以从下一轮删除', () => {
  const plan = roomPlan();
  plan.boundaries!.push({ id: 'south', segment: [[3, 0], [10, 0]], kind: 'wall', leftSpaceId: 'studio', rightSpaceId: 'outside' });
  plan.openings!.push({ id: 'win', hostBoundaryId: 'south', position: 2, width: 1, height: 1.2, sillHeight: 0.9 });
  plan.windows = [{ id: 'w1', openingId: 'win' }];
  const first = compileLayoutPlan(plan, catalog(), 'rev-0001').model;
  plan.openings![1].position = 4; plan.openings![1].sillHeight = 1.1;
  const second = compileLayoutPlan(plan, fromParent(first), 'rev-0002').model;
  assert.equal(second.windows.length, 1);
  assert.ok(Math.abs(second.openings.find((opening) => opening.id === 'win')!.position - 7) < 0.01);
  assert.equal(second.openings.find((opening) => opening.id === 'win')!.sillHeight, 1.1);
  plan.openings!.pop(); plan.windows = [];
  const third = compileLayoutPlan(plan, fromParent(second), 'rev-0003').model;
  assert.equal(third.windows.length, 0);
  assert.equal(third.openings.some((opening) => opening.id === 'win'), false);
});

test('v2 门的 connects 按实际洞口区间判断，而非同一长墙的第一组空间', () => {
  const plan = roomPlan();
  plan.spaces[1].boundary = rectangle(3, 4, 10, 8);
  plan.spaces.push({ id: 'rest', usage: '休息区', enclosed: false, boundary: rectangle(3, 0, 10, 4) });
  plan.boundaries![0].segment = [[3, 4], [3, 8]];
  plan.boundaries!.unshift({ id: 'lower', segment: [[3, 0], [3, 4]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'rest' });
  const { model } = compileLayoutPlan(plan, fromParent(fixedPartition()), 'rev-0002', true);
  assert.equal(model.openings[0].position, 5);
  plan.doors![0].connects = ['hall', 'rest'];
  assert.throws(() => compileLayoutPlan(plan, fromParent(fixedPartition()), 'rev-0002'), /connects/);
});

test('v2 同一洞口不能被门窗或多个同类构件重复占用', () => {
  for (const kind of ['mixed', 'doors', 'windows']) {
    const plan = roomPlan();
    if (kind === 'mixed') plan.windows = [{ id: 'w1', openingId: 'o1' }];
    if (kind === 'doors') plan.doors!.push({ ...plan.doors![0], id: 'd2' });
    if (kind === 'windows') { plan.doors = []; plan.windows = [{ id: 'w1', openingId: 'o1' }, { id: 'w2', openingId: 'o1' }]; }
    assert.throws(() => compileLayoutPlan(plan, catalog(), 'rev-0001'), /只能安装一个/);
  }
  const model = compileLayoutPlan(roomPlan(), catalog(), 'rev-0001').model;
  model.windows.push({ id: 'w1', openingId: 'o1', analysisProperties: {} });
  assert.match(validateStoredDesign(model).errors.join(), /只能安装一个/);
});

test('v2 窗台高度验证、持久化与毫米单位保持一致', () => {
  for (const scale of [1, 1000]) {
    const plan: LayoutPlanV2 = { schemaVersion: 2, spaces: [{ id: 'hall', usage: '门厅', enclosed: false, boundary: rectangle(0, 0, 10 * scale, 8 * scale) }],
      boundaries: [{ id: 'south', segment: [[0, 0], [10 * scale, 0]], kind: 'wall', leftSpaceId: 'hall', rightSpaceId: 'outside' }],
      openings: [{ id: 'win', hostBoundaryId: 'south', position: 5 * scale, width: 2 * scale, height: 1.2 * scale, sillHeight: 0.9 * scale }],
      windows: [{ id: 'w1', openingId: 'win' }], assumptions: [], unmetRequirements: [] };
    const cat = createLayoutContext(JSON.stringify({ boundary: rectangle(0, 0, 10 * scale, 8 * scale), origin: [0, 0], units: scale === 1 ? 'm' : 'mm' }));
    const model = compileLayoutPlan(plan, cat, 'rev-0001', true).model;
    assert.equal(JSON.parse(JSON.stringify(model)).openings[0].sillHeight, 0.9 * scale);
    assert.equal(validateStoredDesign(model).valid, true);
    plan.openings![0].sillHeight = 2 * scale;
    assert.throws(() => compileLayoutPlan(plan, cat, 'rev-0002'), /顶部超过/);
    plan.openings![0].sillHeight = -1;
    assert.throws(() => compileLayoutPlan(plan, cat, 'rev-0002'), /sillHeight/);
  }
});

test('v2 提示词说明外边界、洞口中心和全量更新，不锁定已生成的门窗', () => {
  const parent = compileLayoutPlan(roomPlan(), catalog(), 'rev-0001').model;
  const prompt = buildSpacePrompt('rev-0002', { source: 'parent', outline: outlineToText(parent), currentModel: parent });
  for (const text of ['outside', 'position', 'sillHeight', '全量提交', '可编辑 v2 构件', 'topology', 'schemaVersion 3']) assert.ok(prompt.includes(text));
  assert.match(prompt, /保留墙：\[\]/);
  assert.match(prompt, /保留洞口：\[\]/);
});
