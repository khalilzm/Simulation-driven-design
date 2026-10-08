import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OptimizationRun, PedestrianResult, SpaceModel, SunlightResult } from '@sdd/shared';
import { workspacesDir } from '../src/config';
import { saveDesign } from '../src/model/store';
import { loadOptimizationComparison } from '../src/optimization/comparison';
import { compareCandidate } from '../src/optimization/evaluate';
import { widenDoor } from '../src/optimization/patch';
import { adoptOptimization, prepareOptimization } from '../src/optimization/run';
import { hashValue, optimizationDir, saveOptimization, writeJson } from '../src/optimization/store';
import { computeSunlightInputHash } from '../src/sunlight/hash';
import { computePedestrianInputHash } from '../src/pedestrian/hash';
import { comparisonPresentation } from '../../web/src/viewer/optimizationComparison';
import { sunlightGridsToFills } from '../../web/src/viewer/sunlightMeshRender';
import { pedestrianDensityToFills } from '../../web/src/viewer/pedestrianMeshRender';
import { trajectoriesToLineGroups } from '../../web/src/viewer/pedestrianTrajectories';
import { evaluation, optimizationModel, optimizationRequest, optimizationSunlight, optimizationPedestrian } from './helpers/optimization';

/** Saved synthetic artifacts exercise the read/compare path without starting either engine. */
function persistAnalysis(run: OptimizationRun, model: SpaceModel, duration: number, maximum: number) {
  const evidence = evaluation(duration);
  evidence.scenarioHash = run.scenarioHash;
  evidence.sunlight.taskId = randomUUID(); evidence.pedestrian.taskId = randomUUID();
  evidence.sunlight.inputHash = computeSunlightInputHash(model, run.configs.sunlight, evidence.sunlight.engineVersion);
  evidence.pedestrian.inputHash = computePedestrianInputHash(model, run.configs.pedestrian, evidence.pedestrian.engineVersion);
  const sunlight: SunlightResult = { schemaVersion: '1', status: 'completed', engineVersion: evidence.sunlight.engineVersion,
    metrics: { unit: 'hour', sensorCount: 50, targetAreaRatio: evidence.sunlight.targetAreaRatio },
    spaces: evidence.sunlight.spaces, verification: { status: 'passed', checks: [] },
    legend: { colorSet: 'ecotect', legendParameters: { min: 0, max: maximum } },
    grids: [{ gridId: 'sun-grid', spaceId: 'roomA', vertices: [[0, 0, 0.75], [1, 0, 0.75], [0, 1, 0.75]], faces: [[0, 1, 2]], hours: [1] }] };
  const pedestrian: PedestrianResult = { schemaVersion: '1', status: 'completed', scenario: 'egress', engineVersion: evidence.pedestrian.engineVersion,
    metrics: { unit: 'second', totalAgents: 30, egressTimeSec: duration, meanEgressTimeSec: duration / 2, peakDoorDensity: [], bottleneckSpaceIds: [] },
    verification: { status: 'passed', checks: [] },
    densityGrid: { gridId: 'density', vertices: [[0, 0], [1, 0], [0, 1], [1, 1]], faces: [[0, 1, 2], [1, 3, 2]], density: [1, maximum] },
    trajectories: [{ agentId: 1, spaceId: 'roomA', times: [0, 1, duration], points: [[0, 0], [1, 1], [2, 2]] }] };
  for (const kind of ['sunlight', 'pedestrian'] as const) {
    const dir = path.join(workspacesDir, run.sessionId, 'simulations', evidence[kind].taskId);
    writeJson(path.join(dir, 'envelope.json'), { taskId: evidence[kind].taskId, sessionId: run.sessionId,
      revisionId: run.baseRevisionId, tool: `${kind}.run`, inputHash: evidence[kind].inputHash, status: 'completed' });
    writeJson(path.join(dir, 'model.frozen.json'), model);
    writeJson(path.join(dir, `${kind}.frozen.json`), run.configs[kind]);
    writeJson(path.join(dir, 'result.json'), kind === 'sunlight' ? sunlight : pedestrian);
  }
  return evidence;
}

function fixture() {
  const sessionId = `comparison-test-${randomUUID()}`;
  const model = optimizationModel();
  saveDesign(sessionId, model);
  const designDir = path.join(workspacesDir, sessionId, 'designs/rev-0001');
  writeJson(path.join(designDir, 'sunlight.json'), optimizationSunlight);
  writeJson(path.join(designDir, 'pedestrian.json'), optimizationPedestrian);
  const { run } = prepareOptimization(optimizationRequest(sessionId));
  const candidate = widenDoor(model, run.request, 1.1);
  writeJson(path.join(optimizationDir(sessionId, run.id), 'baseline.json'), model);
  writeJson(path.join(optimizationDir(sessionId, run.id), 'candidate-1.json'), candidate);
  run.baseline = persistAnalysis(run, model, 20, 2);
  const next = persistAnalysis(run, candidate, 18, 4);
  run.candidates = [{ id: 'candidate-1', patch: { type: 'resizeOpening', openingId: 'inside', expectedWidthM: 0.8, widthM: 1.1, maxWidthM: 1.4 }, rationale: '试算', status: 'completed', modelHash: hashValue(candidate),
    evaluation: next, assessment: compareCandidate(run.baseline, next) }];
  run.status = 'completed'; run.outcome = 'improved'; run.recommendedCandidateId = 'candidate-1';
  saveOptimization(run);
  return { run, designDir, cleanup: () => fs.rmSync(path.join(workspacesDir, sessionId), { recursive: true, force: true }) };
}

test('对比同时返回原方案和候选的网格、轨迹，采用后仍可读取同一轮证据', (t) => {
  const { run, cleanup } = fixture(); t.after(cleanup);
  const data = loadOptimizationComparison(run.sessionId, run.id, 'candidate-1');
  assert.equal(data.baseline.model.openings[0].width, 0.8);
  assert.equal(data.candidate.model.openings[0].width, 1.1);
  assert.equal(data.baseline.pedestrian.metrics.egressTimeSec, 20);
  assert.equal(data.candidate.pedestrian.metrics.egressTimeSec, 18);
  assert.equal(data.baseline.sunlight.grids?.[0].hours[0], 1);
  assert.ok(data.candidate.pedestrian.trajectories?.length);
  const revisionId = adoptOptimization(run.sessionId, run.id, 'candidate-1', 'rev-0001');
  const adopted = loadOptimizationComparison(run.sessionId, run.id, 'candidate-1');
  assert.equal(adopted.run.adopted?.revisionId, revisionId);
  assert.deepEqual(adopted.baseline, data.baseline);
  assert.deepEqual(adopted.candidate, data.candidate);
});

test('后续改动当前方案不影响历史图；不同模型的任务文件不得混入同一候选', (t) => {
  const { run, cleanup, designDir } = fixture(); t.after(cleanup);
  const original = loadOptimizationComparison(run.sessionId, run.id, 'candidate-1');
  const changed = structuredClone(original.baseline.model); changed.openings[0].width = 1.2;
  writeJson(path.join(designDir, 'model.json'), changed);
  writeJson(path.join(designDir, 'sunlight.json'), { ...optimizationSunlight, northDegrees: 45 });
  assert.deepEqual(loadOptimizationComparison(run.sessionId, run.id, 'candidate-1').baseline, original.baseline);
  assert.throws(() => adoptOptimization(run.sessionId, run.id, 'candidate-1', 'rev-0001'), /已变化/);
  run.candidates[0].evaluation!.sunlight = run.baseline!.sunlight;
  saveOptimization(run);
  assert.throws(() => loadOptimizationComparison(run.sessionId, run.id, 'candidate-1'), /不匹配/);
});

test('缺失分析文件、指标被改动及非法候选都明确失败', (t) => {
  const { run, cleanup } = fixture(); t.after(cleanup);
  assert.throws(() => loadOptimizationComparison(run.sessionId, run.id, '../escape'), /尚未完成/);
  const file = path.join(workspacesDir, run.sessionId, 'simulations', run.candidates[0].evaluation!.pedestrian.taskId, 'result.json');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  result.metrics.egressTimeSec = 1;
  writeJson(file, result);
  assert.throws(() => loadOptimizationComparison(run.sessionId, run.id, 'candidate-1'), /指标.*不一致/);
  fs.unlinkSync(file);
  assert.throws(() => loadOptimizationComparison(run.sessionId, run.id, 'candidate-1'), /文件缺失/);
});

test('对比着色与轨迹时间范围统一，相同数值颜色相同且不修改保存的结果', (t) => {
  const { run, cleanup } = fixture(); t.after(cleanup);
  const data = loadOptimizationComparison(run.sessionId, run.id, 'candidate-1');
  const before = JSON.stringify(data);
  const display = comparisonPresentation(data);
  assert.equal(display.sunlightScale.max, 4); assert.equal(display.densityScale.max, 4);
  assert.equal(display.pedestrianTimeMax, 20);
  const sunA = sunlightGridsToFills(data.baseline.sunlight, display.sunlightScale);
  const sunB = sunlightGridsToFills(data.candidate.sunlight, display.sunlightScale);
  assert.equal(sunA[0].color, sunB[0].color);
  const pedA = pedestrianDensityToFills(data.baseline.pedestrian, display.densityScale);
  const pedB = pedestrianDensityToFills(data.candidate.pedestrian, display.densityScale);
  assert.equal(pedA[0].color, pedB[0].color);
  assert.equal(trajectoriesToLineGroups(data.baseline.pedestrian, display.pedestrianTimeMax)[0].color,
    trajectoriesToLineGroups(data.candidate.pedestrian, display.pedestrianTimeMax)[0].color);
  assert.equal(JSON.stringify(data), before);
});
