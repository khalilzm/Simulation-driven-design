import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandLayoutPlanV3 } from '../src/design/parseLayoutPlan';
import { compileLayoutPlan } from '../src/design/compileLayoutPlan';
import { createLayoutContext } from '../src/design/layoutContext';
import { buildOutlineJson } from '../src/spacePrompt';
import { validateStoredDesign } from '../src/model/designValidity';
import { layoutModel, rectangle } from './helpers/spaceModel';
import { v3Layout } from './helpers/v3Layout';
import { resolvePlanRef, buildFloorPlanTopology } from '../src/design/floorPlanTopology';

function catalog() {
  const model = layoutModel();
  return createLayoutContext(buildOutlineJson({
    boundary: model.floor.boundary,
    origin: model.model.origin,
    bbox: { width: 10, height: 8, area: 80 },
  }));
}

test('v3 展开 loop 与 boundary 引用为合法 v2 坐标', () => {
  const floor = rectangle(0, 0, 10, 8);
  const plan = expandLayoutPlanV3(v3Layout(), floor);
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.spaces.length, 2);
  assert.deepEqual(plan.spaces[0].boundary[0], [0, 0]);
  assert.deepEqual(plan.boundaries![0].segment[0], [5, 0]);
  assert.deepEqual(plan.boundaries![0].segment[1], [5, 8]);
});

test('v3 经 compileLayoutPlan 生成有效 model', () => {
  const { model } = compileLayoutPlan(v3Layout(), catalog(), 'rev-0001', true);
  assert.equal(model.spaces.length, 2);
  assert.equal(validateStoredDesign(model).valid, true);
});

test('v3 禁止 space.boundary 坐标', () => {
  const floor = rectangle(0, 0, 10, 8);
  assert.throws(
    () => expandLayoutPlanV3({
      schemaVersion: 3,
      spaces: [{ id: 'a', usage: '区', enclosed: false, boundary: [[0, 0], [1, 0], [1, 1]], loop: ['V0', 'V1', 'V2'] }],
      assumptions: [],
      unmetRequirements: [],
    }, floor),
    /勿提交 boundary 坐标/,
  );
});

test('resolvePlanRef 拒绝越界 t', () => {
  const topo = buildFloorPlanTopology(rectangle(0, 0, 10, 8));
  assert.throws(() => resolvePlanRef({ edge: 0, t: 1.2 }, topo, 'test'), /t 须在 0～1/);
});
