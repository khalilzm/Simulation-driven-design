import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OptimizationEvaluation, OptimizationRequest, SpaceModel, Vec2 } from '@sdd/shared';
import { applyDesignPatch, candidatePartitionOffsets, candidatePatches, candidateProgramSwaps, candidateWindowPatches } from '../src/optimization/patch';
import { optimizationModel, optimizationRequest } from './helpers/optimization';

test('moveOpening 沿宿主墙移动门洞中心，原模型不被修改', () => {
  const model = optimizationModel();
  const before = structuredClone(model);
  const next = applyDesignPatch(model, { type: 'moveOpening', openingId: 'inside', expectedPosition: 5, position: 7 });
  assert.equal(next.openings.find((o) => o.id === 'inside')!.position, 7);
  assert.equal(model.openings.find((o) => o.id === 'inside')!.position, 5);
  assert.deepEqual(before, model);
});

test('moveOpening 拒绝越权、越界、前置值不匹配与相邻重叠', () => {
  const m = optimizationModel();
  assert.throws(() => applyDesignPatch(m, { type: 'moveOpening', openingId: 'exit', expectedPosition: 5, position: 7 }), /修改范围/);
  assert.throws(() => applyDesignPatch(m, { type: 'moveOpening', openingId: 'inside', expectedPosition: 5, position: 0.3 }), /过于接近墙端/);
  assert.throws(() => applyDesignPatch(m, { type: 'moveOpening', openingId: 'inside', expectedPosition: 6, position: 7 }), /位置已变化/);
  const overlap = optimizationModel();
  overlap.openings.push({ id: 'other', hostWallId: 'partition', position: 7.6, width: 0.4, height: 2.1, sillHeight: 0 });
  assert.throws(() => applyDesignPatch(overlap, { type: 'moveOpening', openingId: 'inside', expectedPosition: 5, position: 7 }), /相邻门窗/);
});

test('applyDesignPatch resizeOpening 与既有增宽等价', () => {
  const model = optimizationModel();
  const next = applyDesignPatch(model, { type: 'resizeOpening', openingId: 'inside', expectedWidthM: 0.8, widthM: 1.1, maxWidthM: 1.4 });
  assert.equal(next.openings.find((o) => o.id === 'inside')!.width, 1.1);
});

test('candidatePatches 枚举增宽与门位微调补丁', () => {
  const patches = candidatePatches(optimizationModel(), optimizationRequest('test'));
  assert.deepEqual(patches.filter((p) => p.type === 'resizeOpening').map((p) => p.widthM), [1.1, 1.4]);
  assert.deepEqual(patches.filter((p) => p.type === 'moveOpening').map((p) => p.position), [4.4, 5.6]);
});

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}
function wallDef(id: string, points: Vec2[], opts: Partial<SpaceModel['walls'][number]> = {}): SpaceModel['walls'][number] {
  return { id, geometry: { type: 'polyline', points }, thickness: 0.2, height: 3, fixed: false, ...opts };
}
function twoRoom(): SpaceModel {
  return {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: rect(0, 0, 20, 10), elevation: 0, height: 3, topObstruction: true, bottomObstruction: true },
    spaceTypes: [{ id: 't', label: '房', color: '#A8C8F0' }],
    spaces: [
      { id: 'roomA', allocationId: 'roomA', typeId: 't', usage: 'A', targetArea: 100, enclosed: true, boundary: rect(0, 0, 10, 10), performancePreferences: {} },
      { id: 'roomB', allocationId: 'roomB', typeId: 't', usage: 'B', targetArea: 100, enclosed: true, boundary: rect(10, 0, 20, 10), performancePreferences: {} },
    ],
    walls: [
      wallDef('partition', [[10, 0], [10, 10]], { role: 'partition' }),
      wallDef('outer-left', [[0, 0], [0, 10]], { fixed: true }),
      wallDef('outer-right', [[20, 0], [20, 10]], { fixed: true }),
      wallDef('outer-top', [[0, 10], [20, 10]], { fixed: true }),
      wallDef('outer-bottom', [[0, 0], [20, 0]], { fixed: true }),
    ],
    openings: [], doors: [], windows: [], fixedContext: [], externalContext: [],
  };
}

test('offsetPartition 平移隔墙并同步两侧房间边界', () => {
  const model = twoRoom();
  const next = applyDesignPatch(model, { type: 'offsetPartition', wallId: 'partition', expectedFrom: [10, 0], expectedTo: [10, 10], offsetM: 0.5 });
  assert.deepEqual(next.walls.find((x) => x.id === 'partition')!.geometry.points, [[9.5, 0], [9.5, 10]]);
  const roomA = next.spaces.find((s) => s.id === 'roomA')!;
  const roomB = next.spaces.find((s) => s.id === 'roomB')!;
  assert.ok(roomA.boundary.some((p) => p[0] === 9.5 && p[1] === 0));
  assert.ok(roomA.boundary.some((p) => p[0] === 9.5 && p[1] === 10));
  assert.ok(roomB.boundary.some((p) => p[0] === 9.5 && p[1] === 0));
  assert.ok(roomB.boundary.some((p) => p[0] === 9.5 && p[1] === 10));
  assert.equal(model.walls.find((x) => x.id === 'partition')!.geometry.points[0][0], 10, '原模型不被修改');
});

test('offsetPartition 拒绝越权、过大偏移与前置值不匹配', () => {
  const m = twoRoom();
  assert.throws(() => applyDesignPatch(m, { type: 'offsetPartition', wallId: 'outer-left', expectedFrom: [0, 0], expectedTo: [0, 10], offsetM: 0.5 }), /修改范围/);
  assert.throws(() => applyDesignPatch(m, { type: 'offsetPartition', wallId: 'partition', expectedFrom: [10, 0], expectedTo: [10, 10], offsetM: 1 }), /±0.6/);
  assert.throws(() => applyDesignPatch(m, { type: 'offsetPartition', wallId: 'partition', expectedFrom: [11, 0], expectedTo: [11, 10], offsetM: 0.5 }), /位置已变化/);
});

test('多段共线隔墙也能被偏移（手绘草图墙）', () => {
  const model = twoRoom();
  model.walls.find((w) => w.id === 'partition')!.geometry.points = [[10, 0], [10, 5], [10, 10]];
  const baseline: OptimizationEvaluation = {
    scenarioHash: 's', sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.5,
      spaces: [
        { spaceId: 'roomA', sensorCount: 10, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.4 },
        { spaceId: 'roomB', sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: null },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 },
  };
  const offsets = candidatePartitionOffsets(model, baseline);
  assert.equal(offsets.length, 2, '多段共线隔墙应产生两向偏移候选');
  assert.deepEqual(offsets[0].expectedFrom, [10, 0]);
  assert.deepEqual(offsets[0].expectedTo, [10, 10]);
  const moved = applyDesignPatch(model, { type: 'offsetPartition', wallId: 'partition', expectedFrom: [10, 0], expectedTo: [10, 10], offsetM: 0.5 });
  assert.deepEqual(moved.walls.find((w) => w.id === 'partition')!.geometry.points, [[9.5, 0], [9.5, 5], [9.5, 10]]);
});

test('candidatePartitionOffsets 枚举日照不足空间的候选隔墙偏移', () => {
  const baseline: OptimizationEvaluation = {
    scenarioHash: 's', sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.5,
      spaces: [
        { spaceId: 'roomA', sensorCount: 10, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.4 },
        { spaceId: 'roomB', sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: 1 },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 },
  };
  const patches = candidatePartitionOffsets(twoRoom(), baseline);
  assert.deepEqual(patches.map((p) => p.wallId), ['partition', 'partition']);
  assert.deepEqual(patches.map((p) => p.offsetM), [0.3, -0.3]);
});

test('swapProgram 交换两个空间的功能', () => {
  const model = twoRoom();
  const next = applyDesignPatch(model, { type: 'swapProgram', spaceA: 'roomA', spaceB: 'roomB' });
  assert.equal(next.spaces.find((s) => s.id === 'roomA')!.usage, 'B');
  assert.equal(next.spaces.find((s) => s.id === 'roomB')!.usage, 'A');
  assert.equal(model.spaces.find((s) => s.id === 'roomA')!.usage, 'A', '原模型不被修改');
});

test('swapProgram 拒绝不存在的空间与相同空间', () => {
  const m = twoRoom();
  assert.throws(() => applyDesignPatch(m, { type: 'swapProgram', spaceA: 'roomA', spaceB: 'missing' }), /现有的两个空间/);
  assert.throws(() => applyDesignPatch(m, { type: 'swapProgram', spaceA: 'roomA', spaceB: 'roomA' }), /不同的空间/);
});

test('candidateProgramSwaps 枚举低日照有目标空间与无目标空间的交换', () => {
  const baseline: OptimizationEvaluation = {
    scenarioHash: 's', sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.5,
      spaces: [
        { spaceId: 'roomA', sensorCount: 10, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.4 },
        { spaceId: 'roomB', sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: null },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 },
  };
  const swaps = candidateProgramSwaps(twoRoom(), baseline);
  assert.deepEqual(swaps.map((s) => [s.spaceA, s.spaceB]), [['roomA', 'roomB']]);
});

function windowModel(): SpaceModel {
  const m = twoRoom();
  m.openings.push({ id: 'door-open', hostWallId: 'partition', position: 5, width: 0.8, height: 2.1, sillHeight: 0 });
  m.doors.push({ id: 'door-d', openingId: 'door-open', swing: 'none', analysisProperties: {} });
  m.openings.push({ id: 'win-inner', hostWallId: 'partition', position: 2.5, width: 1.0, height: 1.4, sillHeight: 0.8 });
  m.windows.push({ id: 'fill-win-inner', openingId: 'win-inner', analysisProperties: {} });
  return m;
}

test('resizeWindow 增宽外窗，moveWindow 沿墙移动外窗', () => {
  const model = windowModel();
  const widened = applyDesignPatch(model, { type: 'resizeWindow', openingId: 'win-inner', expectedWidthM: 1.0, widthM: 1.3, maxWidthM: 1.4 });
  assert.equal(widened.openings.find((o) => o.id === 'win-inner')!.width, 1.3);
  const moved = applyDesignPatch(model, { type: 'moveWindow', openingId: 'win-inner', expectedPosition: 2.5, position: 3.5 });
  assert.equal(moved.openings.find((o) => o.id === 'win-inner')!.position, 3.5);
  assert.equal(model.openings.find((o) => o.id === 'win-inner')!.width, 1.0, '原模型不被修改');
});

test('resizeWindow 拒绝门洞与超出上限', () => {
  const m = windowModel();
  assert.throws(() => applyDesignPatch(m, { type: 'resizeWindow', openingId: 'door-open', expectedWidthM: 0.8, widthM: 1.0, maxWidthM: 1.2 }), /外窗/);
  assert.throws(() => applyDesignPatch(m, { type: 'resizeWindow', openingId: 'win-inner', expectedWidthM: 1.0, widthM: 1.6, maxWidthM: 1.5 }), /上限/);
});

test('candidateWindowPatches 枚举日照不足空间的外窗增宽与位移候选', () => {
  const baseline: OptimizationEvaluation = {
    scenarioHash: 's', sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.5,
      spaces: [
        { spaceId: 'roomA', sensorCount: 10, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.4 },
        { spaceId: 'roomB', sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: 1 },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 },
  };
  const patches = candidateWindowPatches(windowModel(), baseline);
  assert.deepEqual(patches.filter((p) => p.type === 'resizeWindow').map((p) => (p as { widthM: number }).widthM), [1.2, 1.4]);
  assert.deepEqual(patches.filter((p) => p.type === 'moveWindow').map((p) => (p as { position: number }).position), [1.9, 3.1]);
});

test('配好 targets 后，候选枚举同时包含门洞与日照三类操作', () => {
  const model = windowModel();
  const request: OptimizationRequest = { sessionId: 's', revisionId: 'rev-0001', provider: 'cursor',
    message: '日照', openingId: 'door-open', expectedWidthM: 0.8, maxWidthM: 1.4, confirmEditable: true };
  const baseline: OptimizationEvaluation = {
    scenarioHash: 's', sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.5,
      spaces: [
        { spaceId: 'roomA', sensorCount: 10, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.4 },
        { spaceId: 'roomB', sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: null },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 },
  };
  const allowed = [...candidatePatches(model, request), ...candidatePartitionOffsets(model, baseline),
    ...candidateProgramSwaps(model, baseline), ...candidateWindowPatches(model, baseline)]
    .filter((patch) => { try { applyDesignPatch(model, patch); return true; } catch { return false; } });
  const types = new Set(allowed.map((p) => p.type));
  for (const t of ['resizeOpening', 'moveOpening', 'offsetPartition', 'swapProgram', 'resizeWindow', 'moveWindow'] as const) {
    assert.ok(types.has(t), `缺少 ${t}`);
  }
});
