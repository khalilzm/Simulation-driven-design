import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '@sdd/shared';
import {
  parseSpaceColor,
  parseSpaceType,
  polygonCentroid,
  polygonInteriorLabelPoint,
  pointInOrOnPolygon,
  resolveSpaceLabel,
  resolveSpaceStyle,
  validateSpaceUsage,
} from '@sdd/shared';
import { validateModel } from '../src/model/validate';

test('polygonCentroid 矩形质心为中心', () => {
  const c = polygonCentroid([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  assert.ok(Math.abs(c[0] - 5) < 1e-6);
  assert.ok(Math.abs(c[1] - 4) < 1e-6);
});

test('polygonInteriorLabelPoint L 形多边形锚点在内部', () => {
  const boundary: Vec2[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10], [0, 0]];
  const closed = [...boundary];
  const p = polygonInteriorLabelPoint(boundary);
  assert.ok(pointInOrOnPolygon(p, closed));
});

test('resolveSpaceLabel 回退到 spaceType.label', () => {
  const label = resolveSpaceLabel(
    {
      id: 'sp-1',
      typeId: 'meeting',
      usage: '',
      boundary: [[0, 0], [1, 0], [1, 1], [0, 0]],
      targetArea: 1,
      performancePreferences: {},
    },
    [{ id: 'meeting', label: '会议室', color: '#E8D5B5' }],
  );
  assert.equal(label, '会议室');
});

test('parseSpaceColor 解析 hex 颜色', () => {
  assert.equal(parseSpaceColor('#FFE4A8'), 0xffe4a8);
  assert.equal(parseSpaceColor('0xA8C8F0'), 0xa8c8f0);
  assert.equal(parseSpaceColor('#F00'), 0xff0000);
});

test('parseSpaceType 解析功能区类型', () => {
  const t = parseSpaceType({ id: 'meeting', label: '会议室', color: '#E8D5B5' });
  assert.ok(t);
  assert.equal(t?.id, 'meeting');
  assert.equal(t?.label, '会议室');
});

test('resolveSpaceStyle 使用 Agent 定义的颜色', () => {
  const style = resolveSpaceStyle(
    {
      id: 'mr-1',
      typeId: 'meeting',
      usage: '会议室',
      boundary: [[0, 0], [1, 0], [1, 1], [0, 0]],
      targetArea: 1,
      performancePreferences: {},
    },
    [{ id: 'meeting', label: '会议室', color: '#E8D5B5' }],
  );
  assert.equal(style.fillColor, 0xe8d5b5);
  assert.equal(style.showLabel, true);
});

test('resolveSpaceStyle container 类型低透明度但仍显示标签', () => {
  const style = resolveSpaceStyle(
    {
      id: 'unit-a',
      typeId: 'unit',
      usage: 'A户',
      boundary: [[0, 0], [1, 0], [1, 1], [0, 0]],
      targetArea: 1,
      performancePreferences: {},
    },
    [{ id: 'unit', label: 'A户', color: '#DDD4C8', container: true }],
  );
  assert.equal(style.fillOpacity, 0.08);
  assert.equal(style.showLabel, true);
});

test('validateSpaceUsage 拒绝泛称「房间」', () => {
  const errors = validateSpaceUsage('房间', 'sp-1');
  assert.ok(errors.length > 0);
});

test('validateSpaceUsage 接受场景自由命名', () => {
  assert.deepEqual(validateSpaceUsage('开放办公', 'sp-1'), []);
  assert.deepEqual(validateSpaceUsage('包厢', 'sp-2'), []);
});

test('validateModel 要求 spaceTypes 与 typeId', () => {
  const v = validateModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaces: [
      {
        id: 'sp-1',
        boundary: [[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]],
        usage: '会议室',
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
  assert.ok(v.errors.some((e) => e.includes('spaceTypes')));
});
