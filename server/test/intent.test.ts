import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesignIntent } from '../src/design/intent';

const valid = {
  schemaVersion: 1,
  units: 'm',
  building: { totalArea: { min: 80, target: 90 } },
  rooms: [
    { id: 'living', usage: '客厅', area: { min: 20, target: 25 }, orientation: ['south'], privacy: 'public', priority: 'hard' },
    { id: 'bed', usage: '卧室', area: { min: 10, target: 12 } },
  ],
  adjacencies: [{ a: 'living', b: 'bed', relation: 'adjacent' }],
  daylight: [{ roomIds: ['living'], minHours: 3 }],
  assumptions: [],
  unmetRequirements: [],
};

test('parseDesignIntent 接受合法意图', () => {
  const r = parseDesignIntent(valid);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.rooms.length, 2);
  assert.deepEqual(r.intent.rooms[0].orientation, ['south']);
  assert.equal(r.intent.adjacencies[0].relation, 'adjacent');
});

test('parseDesignIntent 拒绝错误 schemaVersion', () => {
  const r = parseDesignIntent({ ...valid, schemaVersion: 2 });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('schemaVersion')));
});

test('parseDesignIntent 拒绝悬空邻接引用', () => {
  const r = parseDesignIntent({ ...valid, adjacencies: [{ a: 'living', b: 'ghost', relation: 'adjacent' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('ghost')));
});

test('parseDesignIntent 拒绝 area.min 大于 target', () => {
  const r = parseDesignIntent({ ...valid, rooms: [{ id: 'x', usage: 'x', area: { min: 20, target: 10 } }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('min 不能大于 target')));
});

test('parseDesignIntent 拒绝非法朝向枚举', () => {
  const r = parseDesignIntent({ ...valid, rooms: [{ id: 'x', usage: 'x', orientation: ['southward'] }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('orientation[0]')));
});

test('parseDesignIntent 拒绝重复房间 id', () => {
  const r = parseDesignIntent({ ...valid, rooms: [{ id: 'x', usage: 'a' }, { id: 'x', usage: 'b' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('重复')));
});

test('parseDesignIntent 拒绝保留 id outside', () => {
  const r = parseDesignIntent({ ...valid, rooms: [{ id: 'outside', usage: 'x' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('outside')));
});

test('parseDesignIntent 拒绝缺失 minHours', () => {
  const r = parseDesignIntent({ ...valid, daylight: [{ roomIds: ['living'] }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('minHours')));
});

test('parseDesignIntent 拒绝 daylight 悬空引用', () => {
  const r = parseDesignIntent({ ...valid, daylight: [{ roomIds: ['ghost'], minHours: 3 }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('ghost')));
});

test('parseDesignIntent 接受 circulation 走廊', () => {
  const r = parseDesignIntent({ ...valid, circulation: [{ id: 'corridor', usage: '走廊', orientation: 'horizontal', width: 2 }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.circulation?.length, 1);
  assert.equal(r.intent.circulation?.[0].orientation, 'horizontal');
  assert.equal(r.intent.circulation?.[0].width, 2);
});

test('parseDesignIntent 拒绝 circulation 与房间 id 冲突', () => {
  const r = parseDesignIntent({ ...valid, circulation: [{ id: 'living', usage: '走廊', orientation: 'horizontal' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('冲突')));
});

test('parseDesignIntent 拒绝非法 corridor orientation', () => {
  const r = parseDesignIntent({ ...valid, circulation: [{ id: 'corridor', usage: '走廊', orientation: 'diagonal' }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('orientation')));
});

test('parseDesignIntent 接受 windows 窗户清单', () => {
  const r = parseDesignIntent({ ...valid, windows: [{ spaceId: 'living', orientation: 'south', width: 1.8, height: 2.0, sillHeight: 0.9 }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.windows?.[0].spaceId, 'living');
  assert.equal(r.intent.windows?.[0].orientation, 'south');
  assert.equal(r.intent.windows?.[0].width, 1.8);
  assert.equal(r.intent.windows?.[0].height, 2.0);
  assert.equal(r.intent.windows?.[0].sillHeight, 0.9);
});

test('parseDesignIntent 拒绝缺失 window.width', () => {
  const r = parseDesignIntent({ ...valid, windows: [{ spaceId: 'living', orientation: 'south', height: 2.0 }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('width')));
});

test('parseDesignIntent 拒绝 windows 悬空 spaceId', () => {
  const r = parseDesignIntent({ ...valid, windows: [{ spaceId: 'ghost', orientation: 'south', width: 1.5, height: 1.5 }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('ghost')));
});

test('parseDesignIntent 接受 doors 门意图', () => {
  const r = parseDesignIntent({ ...valid, doors: [{ connects: ['living', 'bed'], swing: 'right', leafCount: 2, width: 1.5, height: 2.4 }] });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.intent.doors?.[0].swing, 'right');
  assert.equal(r.intent.doors?.[0].leafCount, 2);
  assert.equal(r.intent.doors?.[0].width, 1.5);
  assert.equal(r.intent.doors?.[0].height, 2.4);
});

test('parseDesignIntent 拒绝 doors 悬空引用', () => {
  const r = parseDesignIntent({ ...valid, doors: [{ connects: ['living', 'ghost'] }] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.ok(r.errors.some((e) => e.includes('ghost')));
});
