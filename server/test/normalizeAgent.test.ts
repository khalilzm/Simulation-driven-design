import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePolygon } from '../src/geometry/polygon';
import { normalizeAgentGeometry } from '../src/model/normalizeAgent';
import { validateAgentModel } from '../src/model/validateAgent';

test('normalizeAgentGeometry 自动补 space boundary 闭合点', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8]]);
  const model = normalizeAgentGeometry({
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: floor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'office', label: '办公', color: '#A8C8F0' }],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'office',
        usage: '办公区',
        boundary: [[0, 0], [5, 0], [5, 8], [0, 8]],
        targetArea: 40,
        performancePreferences: {},
      },
    ],
    walls: [
      { id: 'wall-1', geometry: { type: 'polyline', points: [[0, 0], [10, 0]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-2', geometry: { type: 'polyline', points: [[10, 0], [10, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-3', geometry: { type: 'polyline', points: [[10, 8], [0, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-4', geometry: { type: 'polyline', points: [[0, 8], [0, 0]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-5', geometry: { type: 'polyline', points: [[5, 0], [5, 8]] }, thickness: 0.12, height: 3, fixed: false },
    ],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  });
  assert.deepEqual(model.spaces[0].boundary.at(-1), model.spaces[0].boundary[0]);
  assert.equal(validateAgentModel(model).valid, true);
});

test('validateAgentModel 拒绝重叠 space', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const v = validateAgentModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: floor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'a', label: 'A', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'a',
        usage: 'A区',
        boundary: closePolygon([[0, 0], [6, 0], [6, 8], [0, 8]]),
        targetArea: 0,
        performancePreferences: {},
      },
      {
        id: 'sp-2',
        typeId: 'a',
        usage: 'B区',
        boundary: closePolygon([[4, 0], [10, 0], [10, 8], [4, 8]]),
        targetArea: 0,
        performancePreferences: {},
      },
    ],
    walls: [
      { id: 'wall-1', geometry: { type: 'polyline', points: [[0, 0], [10, 0]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-2', geometry: { type: 'polyline', points: [[10, 0], [10, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-3', geometry: { type: 'polyline', points: [[10, 8], [0, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-4', geometry: { type: 'polyline', points: [[0, 8], [0, 0]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-5', geometry: { type: 'polyline', points: [[5, 0], [5, 8]] }, thickness: 0.12, height: 3, fixed: false },
    ],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('重叠')));
});
