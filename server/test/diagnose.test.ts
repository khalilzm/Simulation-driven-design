import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OptimizationEvaluation, OptimizationRun, SpaceModel, Vec2 } from '@sdd/shared';
import { diagnoseModel } from '../src/optimization/diagnose';

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

function wall(id: string, points: Vec2[], opts: Partial<SpaceModel['walls'][number]> = {}): SpaceModel['walls'][number] {
  return { id, geometry: { type: 'polyline', points }, thickness: 0.2, height: 3, fixed: false, ...opts };
}

function model(): SpaceModel {
  return {
    model: { schemaVersion: '1', revisionId: 'r', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: rect(0, 0, 20, 10), elevation: 0, height: 3, topObstruction: true, bottomObstruction: true },
    spaceTypes: [{ id: 't', label: '房', color: '#A8C8F0' }],
    spaces: [
      { id: 'roomA', allocationId: 'roomA', typeId: 't', usage: '卧室', targetArea: 100, enclosed: true, boundary: rect(0, 0, 10, 10), performancePreferences: {} },
      { id: 'roomB', allocationId: 'roomB', typeId: 't', usage: '客厅', targetArea: 100, enclosed: true, boundary: rect(10, 0, 20, 10), performancePreferences: {} },
    ],
    walls: [
      wall('partition', [[10, 0], [10, 10]], { role: 'partition' }),
      wall('outer-left', [[0, 0], [0, 10]], { fixed: true }),
      wall('outer-right', [[20, 0], [20, 10]], { fixed: true }),
      wall('outer-top', [[0, 10], [20, 10]], { fixed: true }),
      wall('outer-bottom', [[0, 0], [20, 0]], { fixed: true }),
    ],
    openings: [
      { id: 'door-open', hostWallId: 'partition', position: 5, width: 0.8, height: 2.1, sillHeight: 0 },
      { id: 'exit-open', hostWallId: 'outer-left', position: 5, width: 1.2, height: 2.1, sillHeight: 0 },
      { id: 'win-open', hostWallId: 'outer-right', position: 5, width: 2, height: 1.4, sillHeight: 0.8 },
    ],
    doors: [
      { id: 'door-d', openingId: 'door-open', swing: 'none', analysisProperties: {} },
      { id: 'door-e', openingId: 'exit-open', swing: 'none', analysisProperties: {} },
    ],
    windows: [{ id: 'win', openingId: 'win-open', analysisProperties: {} }],
    fixedContext: [],
    externalContext: [],
  };
}

const configs = {
  sunlight: { schemaVersion: '1', location: { latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' },
    analysisDate: '2026-06-21', localTimeRange: ['10:00', '14:00'], northDegrees: 0, timestepMinutes: 60,
    sensors: { gridSpacing: 2, referenceHeightAboveFloor: 0.75 },
    targets: [{ spaceIds: ['roomA'], minHours: 2 }, { spaceIds: ['roomB'], minHours: 2 }] },
  pedestrian: { schemaVersion: '1', scenario: 'egress', model: 'collision-free', dt: 0.05, maxDurationSec: 120, seed: 1,
    agents: [{ spaceId: 'roomA', count: 10 }, { spaceId: 'roomB', count: 20 }] },
} as OptimizationRun['configs'];

const baseline: OptimizationEvaluation = {
  scenarioHash: 'scenario',
  sunlight: { taskId: 'sun', inputHash: 'sun-hash', engineVersion: 'sun-v1', targetAreaRatio: 0.65,
    spaces: [
      { spaceId: 'roomA', sensorCount: 25, sampledArea: 100, meanHours: 1.2, minHours: 0, maxHours: 3, targetMetRatio: 0.3 },
      { spaceId: 'roomB', sensorCount: 25, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: 1 },
    ] },
  pedestrian: { taskId: 'ped', inputHash: 'ped-hash', engineVersion: 'ped-v1', totalAgents: 30, egressTimeSec: 90 },
};

test('日照不足诊断定位到候选隔墙', () => {
  const diagnoses = diagnoseModel(model(), configs, baseline);
  const sun = diagnoses.find((d) => d.issueId === 'sunlight-roomA');
  assert.ok(sun, '应有 roomA 日照不足诊断');
  assert.equal(sun.severity, 'warn');
  assert.deepEqual(sun.wallIds, ['partition']);
  assert.equal(diagnoses.find((d) => d.issueId === 'sunlight-roomB'), undefined, '达标空间不应产生日照诊断');
});

test('疏散诊断给出可改门洞候选（按净宽升序）', () => {
  const diagnoses = diagnoseModel(model(), configs, baseline);
  const egress = diagnoses.find((d) => d.issueId === 'egress-time');
  assert.ok(egress);
  assert.equal(egress.severity, 'info');
  // exit-open 宿主墙 fixed，应被排除；door-open 是可改候选。
  assert.deepEqual(egress.openingIds, ['door-open']);
});

test('不可达空间产生独立诊断', () => {
  const m = model();
  m.spaces.push({ id: 'roomC', allocationId: 'roomC', typeId: 't', usage: '杂物间', targetArea: 40, enclosed: true, boundary: rect(2, 2, 6, 6), performancePreferences: {} });
  const diagnoses = diagnoseModel(m, configs, baseline);
  const unreachable = diagnoses.find((d) => d.issueId === 'egress-unreachable');
  assert.ok(unreachable);
  assert.deepEqual(unreachable.spaceIds, ['roomC']);
});
