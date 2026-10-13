import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OptimizationEvaluation } from '@sdd/shared';
import { compareCandidate } from '../src/optimization/evaluate';
import { evaluation } from './helpers/optimization';
import { optimizationModel } from './helpers/optimization';
import { createResultIdentity } from '../src/analysis/runtime/identity';

test('统一评价层：改善候选五层全过', () => {
  const a = compareCandidate(evaluation(), evaluation(18));
  assert.equal(a.comparable, true);
  assert.equal(a.constraintsSatisfied, true);
  assert.equal(a.goalsSatisfied, true);
  assert.equal(a.eligible, true);
  assert.equal(a.improved, true);
  assert.ok(a.checks.every((c) => c.passed));
});

test('日照退化：仍可比，但约束不满足、不可采用', () => {
  const next = evaluation(18);
  next.sunlight.spaces[0].targetMetRatio = 0.4;
  const a = compareCandidate(evaluation(), next);
  assert.equal(a.comparable, true, '日照退化仍是可比较候选');
  assert.equal(a.constraintsSatisfied, false);
  assert.equal(a.eligible, false);
  assert.equal(a.improved, false);
  assert.equal(a.checks.find((c) => c.category === 'constraint')?.passed, false);
});

test('未清空：数值不完整，不能判为更优', () => {
  const next = evaluation(18);
  next.pedestrian.egressTimeSec = null;
  const a = compareCandidate(evaluation(), next);
  assert.equal(a.comparable, false);
  assert.equal(a.improved, false);
  assert.equal(a.checks.find((c) => c.category === 'completeness' && !c.passed)?.message, '候选完成全部人员疏散');
});

test('无改善：可比且约束满足，但目标不满足', () => {
  const a = compareCandidate(evaluation(), evaluation(19.9));
  assert.equal(a.comparable, true);
  assert.equal(a.constraintsSatisfied, true);
  assert.equal(a.goalsSatisfied, false);
  assert.equal(a.improved, false);
});

test('功能交换：目标随 allocationId 迁移，未达目标对象可让渡日照', () => {
  const context=structuredClone(evaluation().identity!.context);for(const module of context.modules)module.engineVersion='v';
  const base: OptimizationEvaluation = { identity:createResultIdentity(optimizationModel(),context),scenarioHash: 's',
    sunlight: { taskId: 'sun', inputHash: 'h', engineVersion: 'v', targetAreaRatio: 0.7, spaces: [],
      allocations: [
        { allocationId: 'bedroom', spaceIds: ['X'], sensorCount: 10, sampledArea: 100, meanHours: 1.2, minHours: 0, maxHours: 3, targetMetRatio: 0.4 },
        { allocationId: 'storage', spaceIds: ['Y'], sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: null },
      ] },
    pedestrian: { taskId: 'ped', inputHash: 'h', engineVersion: 'v', totalAgents: 10, egressTimeSec: 20 } };
  const next: OptimizationEvaluation = { ...base,
    sunlight: { ...base.sunlight,
      allocations: [
        { allocationId: 'bedroom', spaceIds: ['Y'], sensorCount: 10, sampledArea: 100, meanHours: 4, minHours: 2, maxHours: 6, targetMetRatio: 1 },
        { allocationId: 'storage', spaceIds: ['X'], sensorCount: 10, sampledArea: 100, meanHours: 1.2, minHours: 0, maxHours: 3, targetMetRatio: null },
      ] },
    pedestrian: { ...base.pedestrian, egressTimeSec: 18 } };
  const a = compareCandidate(base, next);
  assert.equal(a.comparable, true);
  assert.equal(a.constraintsSatisfied, true, '未达目标对象让渡日照不应触发保护');
  assert.equal(a.goalsSatisfied, true);
  assert.equal(a.improved, true);
});
