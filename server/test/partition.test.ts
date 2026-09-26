import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePolygon, findSpaceEdgeNotOnPartition, buildPartitionSegments } from '../src/model/geometry';
import { validateAgentModel } from '../src/model/validateAgent';

test('space 边须落在 floor 或内墙分割线上（几何辅助）', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const partition = buildPartitionSegments(floor, [[[5, 0], [5, 8]]]);
  const space = closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]);
  assert.equal(findSpaceEdgeNotOnPartition(space, partition), null);

  const bad = closePolygon([[0, 0], [6, 2], [5, 8], [0, 8], [0, 0]]);
  assert.ok(findSpaceEdgeNotOnPartition(bad, partition));
});

test('validateAgentModel 允许未贴分割线的 space 边（只要在轮廓内）', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const v = validateAgentModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: floor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'a', label: 'A区', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-bad',
        typeId: 'a',
        usage: 'A区',
        boundary: closePolygon([[0, 0], [7, 0], [5, 8], [0, 8], [0, 0]]),
        targetArea: 0,
        performancePreferences: {},
      },
    ],
    walls: [
      { id: 'wall-1', geometry: { type: 'polyline', points: [[0, 0], [10, 0]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-2', geometry: { type: 'polyline', points: [[10, 0], [10, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-3', geometry: { type: 'polyline', points: [[10, 8], [0, 8]] }, thickness: 0.12, height: 3, fixed: false },
      { id: 'wall-4', geometry: { type: 'polyline', points: [[0, 8], [0, 0]] }, thickness: 0.12, height: 3, fixed: false },
    ],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  });
  assert.equal(v.valid, true);
});
