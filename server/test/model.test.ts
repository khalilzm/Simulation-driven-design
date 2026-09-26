import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceModel } from '@sdd/shared';
import { validateModel } from '../src/model/validate';
import { checkFixedPreserved, checkOutlinePreserved, listDesigns } from '../src/model/store';

function validModel(): SpaceModel {
  return {
    model: {
      schemaVersion: '1',
      revisionId: 'rev-0001',
      parentRevisionId: null,
      units: 'm',
      origin: [0, 0],
    },
    floor: {
      boundary: [
        [0, 0],
        [10, 0],
        [10, 8],
        [0, 8],
        [0, 0],
      ],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'living', label: '客厅', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'space-1',
        typeId: 'living',
        boundary: [
          [0, 0],
          [5, 0],
          [5, 8],
          [0, 8],
          [0, 0],
        ],
        usage: '客厅',
        targetArea: 40,
        performancePreferences: {},
      },
    ],
    walls: [
      {
        id: 'wall-1',
        geometry: { type: 'polyline', points: [[0, 0], [10, 0]] },
        thickness: 0.2,
        height: 3,
        fixed: true,
      },
      {
        id: 'wall-int-1',
        geometry: { type: 'polyline', points: [[5, 0], [5, 8]] },
        thickness: 0.2,
        height: 3,
        fixed: false,
      },
    ],
    openings: [
      { id: 'opening-1', hostWallId: 'wall-1', position: 5, width: 1.2, height: 2.1, fillRef: 'door-1' },
    ],
    doors: [{ id: 'door-1', openingId: 'opening-1', swing: 'left', analysisProperties: {} }],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
}

test('合法模型通过', () => {
  const r = validateModel(validModel());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('非法单位被拒', () => {
  const m = validModel();
  (m.model as { units: string }).units = 'ft';
  assert.equal(validateModel(m).valid, false);
});

test('退化边界（面积为零）被拒', () => {
  const m = validModel();
  m.floor.boundary = [
    [0, 0],
    [5, 0],
    [10, 0],
  ];
  assert.equal(validateModel(m).valid, false);
});

test('宿主墙不存在被拒', () => {
  const m = validModel();
  m.openings[0].hostWallId = 'wall-999';
  assert.equal(validateModel(m).valid, false);
});

test('door 洞口不存在被拒', () => {
  const m = validModel();
  m.doors[0].openingId = 'opening-999';
  assert.equal(validateModel(m).valid, false);
});

test('重复 wall id 被拒', () => {
  const m = validModel();
  m.walls.push({
    id: 'wall-1',
    geometry: { type: 'polyline', points: [[0, 0], [1, 0]] },
    thickness: 0.2,
    height: 3,
    fixed: false,
  });
  assert.equal(validateModel(m).valid, false);
});

test('revisionId 格式非法被拒', () => {
  const m = validModel();
  (m.model as { revisionId: string }).revisionId = 'abc';
  assert.equal(validateModel(m).valid, false);
});

test('fixed wall 未修改通过', () => {
  assert.equal(checkFixedPreserved(validModel(), validModel()), null);
});

test('fixed wall 几何被修改被拒', () => {
  const parent = validModel();
  const child = validModel();
  child.walls[0].geometry = { type: 'polyline', points: [[0, 0], [9, 0]] };
  assert.ok(checkFixedPreserved(parent, child));
});

test('外轮廓未修改通过', () => {
  assert.equal(checkOutlinePreserved(validModel(), validModel()), null);
});

test('floor 外轮廓被修改被拒', () => {
  const parent = validModel();
  const child = validModel();
  child.floor.boundary = [
    [0, 0],
    [11, 0],
    [11, 8],
    [0, 8],
    [0, 0],
  ];
  assert.ok(checkOutlinePreserved(parent, child));
});

test('listDesigns 容忍 Agent 扁平 schema 的 model.json', () => {
  const designs = listDesigns('a6d8eb3a-1608-42b6-9232-4115d03335aa');
  assert.equal(designs.length, 1);
  assert.equal(designs[0].revisionId, 'rev-0001');
  assert.equal(designs[0].parentRevisionId, null);
});

