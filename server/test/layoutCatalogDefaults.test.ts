import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLayoutPlan } from '../src/design/parseLayoutPlan';
import { compileLayoutPlan } from '../src/design/compileLayoutPlan';
import { createLayoutContext } from '../src/design/layoutContext';
import { buildOutlineJson } from '../src/spacePrompt';
import { layoutModel, rectangle } from './helpers/spaceModel';
import { v3Layout } from './helpers/v3Layout';

function catalog() {
  const model = layoutModel();
  return createLayoutContext(buildOutlineJson({
    boundary: model.floor.boundary,
    origin: model.model.origin,
    bbox: { width: 10, height: 8, area: 80 },
  }));
}

test('openings 仅 typeId 时由目录填充 width/height', () => {
  const floor = rectangle(0, 0, 10, 8);
  const raw = v3Layout({
    openings: [{ id: 'o1', hostBoundaryId: 'split', position: 4, typeId: 'door-single-900' }],
    doors: [{ id: 'd1', openingId: 'o1', typeId: 'door-single-900', connects: ['hall', 'studio'] }],
  });
  const plan = parseLayoutPlan(raw, floor);
  const opening = plan.openings!.find((item) => item.id === 'o1')!;
  assert.equal(opening.width, 0.9);
  assert.equal(opening.height, 2.1);
  const door = plan.doors!.find((item) => item.id === 'd1')!;
  assert.equal(door.swing, 'left');
  assert.equal(door.leafCount, 1);
});

test('compileLayoutPlan 写入 door typeId 到 analysisProperties', () => {
  const raw = v3Layout({
    openings: [{ id: 'o1', hostBoundaryId: 'split', position: 4, typeId: 'door-single-900' }],
    doors: [{ id: 'd1', openingId: 'o1', connects: ['hall', 'studio'] }],
  });
  const { model } = compileLayoutPlan(raw, catalog(), 'rev-0001', true);
  const door = model.doors.find((item) => item.id === 'd1')!;
  assert.equal(door.analysisProperties.typeId, 'door-single-900');
});

test('window typeId 填充 opening 尺寸', () => {
  const floor = rectangle(0, 0, 10, 8);
  const plan = parseLayoutPlan({
    schemaVersion: 2,
    spaces: [{ id: 'a', usage: '区', enclosed: false, boundary: [[0, 0], [10, 0], [10, 8], [0, 8]] }],
    boundaries: [{ id: 'ext', segment: [[0, 0], [10, 0]], kind: 'wall', leftSpaceId: 'a', rightSpaceId: 'outside' }],
    openings: [{ id: 'w1', hostBoundaryId: 'ext', position: 5, typeId: 'window-standard-1500' }],
    windows: [{ id: 'win1', openingId: 'w1' }],
    assumptions: [],
    unmetRequirements: [],
  }, floor);
  assert.equal(plan.openings![0].width, 1.5);
  assert.equal(plan.openings![0].height, 1.5);
});
