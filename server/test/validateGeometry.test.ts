import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateModel } from '../src/model/validate';
import { isPolygonClosed } from '../src/geometry/polygon';

const songBianDianModel =
  '../../workspaces/f1f82520-ff50-41f5-8ce3-dd471478f7c4/designs/rev-0001/model.json';

test('isPolygonClosed 检测首尾闭合', () => {
  assert.equal(isPolygonClosed([[0, 0], [5, 0], [5, 4], [0, 0]]), true);
  assert.equal(isPolygonClosed([[0, 0], [5, 0], [5, 4]]), false);
});

test('validateModel 拒绝未闭合 space', () => {
  const v = validateModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'living', label: '客厅', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'living',
        boundary: [[0, 0], [5, 0], [5, 8], [0, 8]],
        usage: '客厅',
        targetArea: 40,
        performancePreferences: {},
      },
    ],
    walls: [],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('未首尾闭合')));
});

test('validateModel 拒绝窗 position 超出墙段', () => {
  const v = validateModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
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
        id: 'wall-ext-0',
        geometry: { type: 'polyline', points: [[0, 0], [1.2, 0]] },
        thickness: 0.24,
        height: 3,
        fixed: true,
      },
    ],
    openings: [
      { id: 'open-1', hostWallId: 'wall-ext-0', position: 3, width: 1.5, height: 1.5 },
    ],
    doors: [],
    windows: [{ id: 'win-1', openingId: 'open-1' }],
    fixedContext: [],
    externalContext: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('position') || e.includes('1.5m')));
});

test('送变电小区原始模型直接校验应暴露问题（不经后处理）', () => {
  const raw = JSON.parse(fs.readFileSync(new URL(songBianDianModel, import.meta.url), 'utf8'));
  const v = validateModel(raw);
  assert.equal(v.valid, false, '应只读校验 Agent 原始输出，不自动修复');
  assert.ok(v.errors.length > 0);
});
