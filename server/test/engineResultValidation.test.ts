import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EngineCapability, EngineResultByCapability } from '@sdd/shared';
import { parseCompletedEngineResult } from '../src/analysis/runtime/engineResult';

function results(): EngineResultByCapability {
  const mesh = { gridId: 'grid', spaceId: 'room-main', vertices: [[0,0,.75],[1,0,.75],[0,1,.75]] as [number,number,number][], faces: [[0,1,2]] };
  return {
    daylight: { schemaVersion: '1', status: 'completed', engineVersion: 'day@1', method: 'overcast-daylight-factor', outdoorIlluminanceLux: 10000,
      spaces: [{ spaceId: 'room-main', allocationId: 'room-main', sensorCount: 1, sampledArea: 1, meanLux: 400, minLux: 400, maxLux: 400, meanDaylightFactor: 4, targetMetRatio: .5 }],
      grids: [{ ...mesh, lux: [400], daylightFactors: [4] }], assumptions: [] },
    sunlight: { schemaVersion: '1', status: 'completed', engineVersion: 'sun@1', metrics: { unit: 'hour', sensorCount: 1, targetAreaRatio: null },
      spaces: [{ spaceId: 'room-main', sensorCount: 1, meanHours: 2, minHours: 2, maxHours: 2, targetMetRatio: null }],
      grids: [{ ...mesh, hours: [2] }], verification: { status: 'needs_review', checks: [] } },
    pedestrian: { schemaVersion: '1', status: 'completed', engineVersion: 'ped@1', scenario: 'egress',
      metrics: { unit: 'second', totalAgents: 1, egressTimeSec: 2, meanEgressTimeSec: 2, peakDoorDensity: [], bottleneckSpaceIds: [] },
      densityGrid: { gridId: 'density', vertices: [[0,0],[1,0],[0,1]], faces: [[0,1,2]], density: [1] },
      trajectories: [{ agentId: 1, spaceId: 'room-main', times: [0,2], points: [[0,0],[1,1]] }], verification: { status: 'needs_review', checks: [] } },
  };
}
test('each capability retains its own validated result and completed execution does not imply verification passed', () => {
  const sample = results();
  for (const capability of Object.keys(sample) as EngineCapability[]) {
    const raw = sample[capability]; assert.equal(parseCompletedEngineResult(raw, capability, raw.engineVersion), raw);
  }
  sample.sunlight.verification.status = 'failed';
  assert.equal(parseCompletedEngineResult(sample.sunlight, 'sunlight', 'sun@1').status, 'completed');
});
test('missing version, metrics, wrong units and non-finite values cannot be defaulted to successful zero results', () => {
  const sample = results();
  for (const capability of Object.keys(sample) as EngineCapability[]) {
    const raw = sample[capability];
    for (const bad of [{ ...raw, engineVersion: undefined }, { ...raw, schemaVersion: undefined }, { ...raw, extra: { invalid: Infinity } }])
      assert.throws(() => parseCompletedEngineResult(bad, capability, raw.engineVersion), /无效或缺失/);
  }
  assert.throws(() => parseCompletedEngineResult({ ...sample.sunlight, metrics: undefined }, 'sunlight', 'sun@1'), /metrics/);
  assert.throws(() => parseCompletedEngineResult({ ...sample.sunlight, metrics: { ...sample.sunlight.metrics, unit: 'lx' } }, 'sunlight', 'sun@1'), /unit/);
  assert.throws(() => parseCompletedEngineResult({ ...sample.pedestrian, metrics: { ...sample.pedestrian.metrics, unit: 'hour' } }, 'pedestrian', 'ped@1'), /unit/);
});
test('invalid mesh value counts or indices and invalid trajectory times are rejected', () => {
  const sample = results(); sample.daylight.grids[0].lux = [];
  assert.throws(() => parseCompletedEngineResult(sample.daylight, 'daylight', 'day@1'), /count/);
  sample.sunlight.grids![0].faces[0][2] = 99;
  assert.throws(() => parseCompletedEngineResult(sample.sunlight, 'sunlight', 'sun@1'), /index/);
  sample.pedestrian.trajectories![0].times = [2,0];
  assert.throws(() => parseCompletedEngineResult(sample.pedestrian, 'pedestrian', 'ped@1'), /order/);
});
test('engine-reported failures preserve their diagnostic without requiring completed-result metrics', () => {
  assert.throws(() => parseCompletedEngineResult({ schemaVersion: '1', status: 'failed', engineVersion: 'day@1', error: 'recipe failed' }, 'daylight', 'day@1'),
    (error: unknown) => error instanceof Error && error.message === 'recipe failed');
});


test('optional target, sampling and allocation records are validated rather than passed through unchecked', () => {
  const sample = results();
  assert.throws(() => parseCompletedEngineResult({ ...sample.sunlight, targets: 'invalid' }, 'sunlight', 'sun@1'), /targets/);
  assert.throws(() => parseCompletedEngineResult({ ...sample.sunlight, allocations: [{ allocationId: 'room', spaceIds: [] }] }, 'sunlight', 'sun@1'), /sensorCount/);
  assert.throws(() => parseCompletedEngineResult({ ...sample.daylight, sampling: { status: 'converged', baseSpacing: .5, refinedSpacing: .25, rooms: [{ allocationId: 'room', status: 'converged' }] } }, 'daylight', 'day@1'), /meanLuxDelta/);
  const sampling = { status: 'converged' as const, baseSpacing: .5, refinedSpacing: .25, rooms: [{ allocationId: 'room-main', status: 'converged' as const,
    reason: null, meanLuxDelta: 0, targetRatioDelta: 0, baseTargetRatio: .5, refinedTargetRatio: .5 }] };
  assert.equal(parseCompletedEngineResult({ ...sample.daylight, sampling }, 'daylight', 'day@1').sampling?.rooms[0].reason, null);
});
