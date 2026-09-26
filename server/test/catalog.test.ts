import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCatalogForPrompt, getComponentType } from '@sdd/shared';
import { resolveComponentDefaults } from '../src/model/resolveCatalog';
import { validateModel } from '../src/model/validate';
import type { SpaceModel } from '@sdd/shared';

test('getComponentType 返回预定义构件', () => {
  const door = getComponentType('door-single-900');
  assert.ok(door);
  assert.equal(door?.defaults.width, 0.9);
});

test('formatCatalogForPrompt 包含墙门窗电梯', () => {
  const text = formatCatalogForPrompt();
  assert.match(text, /wall-int-200/);
  assert.match(text, /door-single-900/);
  assert.match(text, /window-standard-1500/);
  assert.match(text, /elevator-passenger-2100/);
});

test('resolveComponentDefaults 按 typeId 补齐洞口与墙厚', () => {
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaces: [],
    walls: [
      {
        id: 'wall-int-01',
        geometry: { type: 'polyline', points: [[5, 0], [5, 8]] },
        thickness: 0,
        height: 0,
        fixed: false,
        analysisProperties: { typeId: 'wall-int-200' },
      },
    ],
    openings: [
      {
        id: 'op-1',
        hostWallId: 'wall-int-01',
        position: 3,
        width: 0,
        height: 0,
        fillRef: 'door-single-900',
      },
    ],
    doors: [
      {
        id: 'door-1',
        openingId: 'op-1',
        swing: 'none',
        analysisProperties: { typeId: 'door-single-900' },
      },
    ],
    windows: [],
    fixedContext: [
      {
        id: 'elev-1',
        kind: 'elevator',
        source: 'elevator-passenger-2100',
        geometry: {
          type: 'polyline',
          points: [[1, 1], [3.1, 1], [3.1, 2.6], [1, 2.6]],
        },
      },
    ],
    externalContext: [],
  };

  const resolved = resolveComponentDefaults(model);
  assert.equal(resolved.walls[0].thickness, 0.2);
  assert.equal(resolved.walls[0].height, 3);
  assert.equal(resolved.openings[0].width, 0.9);
  assert.equal(resolved.openings[0].height, 2.1);
  assert.equal(resolved.doors[0].leafCount, 1);
  const v = validateModel(resolved);
  assert.equal(v.valid, true, v.errors.join('; '));
});

test('componentTypes 扩展类型可被引用', () => {
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    componentTypes: [
      {
        id: 'door-sliding-1200',
        category: 'door',
        label: '推拉门1200',
        defaults: { width: 1.2, height: 2.1, leafCount: 1, swing: 'none' },
      },
    ],
    spaces: [],
    walls: [
      {
        id: 'w1',
        geometry: { type: 'polyline', points: [[5, 0], [5, 8]] },
        thickness: 0.2,
        height: 3,
        fixed: false,
      },
    ],
    openings: [
      {
        id: 'op-1',
        hostWallId: 'w1',
        position: 1,
        width: 0,
        height: 0,
        fillRef: 'door-sliding-1200',
      },
    ],
    doors: [{ id: 'd1', openingId: 'op-1', swing: 'none', analysisProperties: { typeId: 'door-sliding-1200' } }],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
  const resolved = resolveComponentDefaults(model);
  assert.equal(resolved.openings[0].width, 1.2);
  const v = validateModel(resolved);
  assert.equal(v.valid, true, v.errors.join('; '));
});

test('裸写墙厚与洞口尺寸通过校验', () => {
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaces: [],
    walls: [
      {
        id: 'w-bare',
        geometry: { type: 'polyline', points: [[5, 0], [5, 8]] },
        thickness: 0.25,
        height: 3,
        fixed: false,
      },
    ],
    openings: [
      { id: 'op-bare', hostWallId: 'w-bare', position: 2, width: 1.1, height: 2.0 },
    ],
    doors: [{ id: 'd-bare', openingId: 'op-bare', swing: 'left', analysisProperties: {} }],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
  const v = validateModel(model);
  assert.equal(v.valid, true, v.errors.join('; '));
  const resolved = resolveComponentDefaults(model);
  assert.equal(resolved.walls[0].analysisProperties?.custom, true);
});

test('未知 typeId 仍被拒绝', () => {
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaces: [],
    walls: [
      {
        id: 'w1',
        geometry: { type: 'polyline', points: [[5, 0], [5, 8]] },
        thickness: 0.2,
        height: 3,
        fixed: false,
        analysisProperties: { typeId: 'wall-unknown-999' },
      },
    ],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
  const v = validateModel(model);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('未知构件类型')));
});
