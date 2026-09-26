import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '@sdd/shared';
import { polygonGeometryError } from '@sdd/shared';
import { diff, intersection } from 'martinez-polygon-clipping';
import gym from './fixtures/gym-outline.json';
import { applyRegionSplits, createRegionCatalog, type RegionSplit } from '../src/design/layoutRegions';
import { compileAllocation } from '../src/design/compileAllocation';
import { geometryArea, outsideArea, unionRings } from '../src/design/regionGeometry';
import { validateAgentModel } from '../src/model/validateAgent';
import { validateModel } from '../src/model/validate';
import { validateLayoutCompleteness } from '../src/model/layoutValidation';
import { layoutModel, rectangle } from './helpers/spaceModel';

const fixtures: [string, Vec2[]][] = [
  ['矩形', rectangle(0, 0, 12, 8)],
  ['L 形', [[0, 0], [12, 0], [12, 4], [4, 4], [4, 10], [0, 10], [0, 0]]],
  ['窄凹口', [[0, 0], [10, 0], [10, 10], [5.1, 10], [5.1, 3], [5, 3], [5, 10], [0, 10], [0, 0]]],
  ['斜边', [[0, 0], [12, 0], [10, 9], [6, 5], [0, 8], [0, 0]]],
  ['旋转矩形', rectangle(0, 0, 12, 8).map(([x, y]) => [x * Math.cos(0.4) - y * Math.sin(0.4), x * Math.sin(0.4) + y * Math.cos(0.4)] as Vec2)],
  ['实际健身房凹轮廓', gym as Vec2[]],
];

for (const [name, boundary] of fixtures) test(`${name}：合法区域无越界、无重叠并覆盖原轮廓`, () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary, origin: [0, 0] }));
  const rings = catalog.regions.map((region) => region.boundary);
  for (let i = 0; i < rings.length; i++) {
    assert.equal(polygonGeometryError(rings[i]), null);
    assert.ok(outsideArea(rings[i], boundary) < 1e-6);
    for (let j = 0; j < i; j++) assert.ok(geometryArea(intersection([rings[i]], [rings[j]])) < 1e-6);
  }
  assert.ok(geometryArea(diff([boundary], unionRings(rings))) < 1e-6);
  const { model } = compileAllocation({ allocations: [{ id: 'open', usage: '开放训练区', regionIds: catalog.regions.map((region) => region.id), enclosed: false }] }, catalog, 'rev-0001', true);
  assert.deepEqual([...validateAgentModel(model).errors, ...validateModel(model).errors, ...validateLayoutCompleteness(model, true)], []);
});

test('矩形按比例连续切分，开放区不加内墙，封闭区生成共墙且不重复', () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary: rectangle(0, 0, 10, 8), origin: [0, 0] }));
  const splits: RegionSplit[] = [{ regionId: 'r1', axis: 'x', ratio: 0.4 }, { regionId: 'r1.a', axis: 'y', ratio: 0.5 }];
  const { model } = compileAllocation({ splits, allocations: [
    { id: 'studio', usage: '团操室', enclosed: true, regionIds: ['r1.a.a'], minArea: 15 },
    { id: 'cardio', usage: '有氧区', enclosed: false, regionIds: ['r1.a.b'] },
    { id: 'strength', usage: '力量区', enclosed: false, regionIds: ['r1.b'] },
  ] }, catalog, 'rev-0001', true);
  assert.equal(model.walls.length, 6);
  assert.deepEqual(model.openings, []);
  assert.deepEqual(model.doors, []);
  assert.deepEqual([...validateAgentModel(model).errors, ...validateModel(model).errors, ...validateLayoutCompleteness(model, true)], []);
  for (const space of model.spaces) assert.ok(outsideArea(space.boundary, model.floor.boundary) < 1e-6);
});

test('拒绝伪造区域、重复分配、任意坐标、无效切分及未满足的最小面积', () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary: rectangle(0, 0, 10, 8), origin: [0, 0] }));
  const allocation = { id: 'studio', usage: '团操室', enclosed: true, regionIds: ['r1'] };
  const { model } = compileAllocation({ allocations: [allocation] }, catalog, 'rev-0001', true);
  assert.equal(model.spaces[0].enclosed, true);
  assert.deepEqual(model.openings, []);
  assert.throws(() => compileAllocation({ allocations: [{ ...allocation, regionIds: ['outside'] }] }, catalog, 'rev-0001'), /不存在/);
  assert.throws(() => compileAllocation({ allocations: [allocation, { ...allocation, id: 'second' }] }, catalog, 'rev-0001'), /重复分配/);
  assert.throws(() => compileAllocation({ allocations: [{ ...allocation, boundary: rectangle(0, 0, 20, 20) }] }, catalog, 'rev-0001'), /任意边界/);
  assert.throws(() => compileAllocation({ allocations: [{ ...allocation, minArea: 100 }] }, catalog, 'rev-0001'), /小于要求/);
  assert.throws(() => applyRegionSplits(catalog, [{ regionId: 'r1', axis: 'x', ratio: 1.2 }]), /0 和 1/);
});

test('不连通封闭房间被拒绝；开放区可分为多个分片并返回提示', () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary: rectangle(0, 0, 12, 8), origin: [0, 0] }));
  const splits: RegionSplit[] = [{ regionId: 'r1', axis: 'x', ratio: 1 / 3 }, { regionId: 'r1.b', axis: 'x', ratio: 0.5 }];
  const allocations = [{ id: 'open', usage: '训练区', enclosed: true, regionIds: ['r1.a', 'r1.b.b'] }];
  assert.throws(() => compileAllocation({ splits, allocations }, catalog, 'rev-0001'), /不连通/);
  allocations[0].enclosed = false;
  const { model, warnings } = compileAllocation({ splits, allocations }, catalog, 'rev-0001');
  assert.equal(model.spaces.length, 2);
  assert.ok(warnings.some((warning) => warning.includes('不连通')));
});

test('围绕内嵌房间的开放区保留孔洞，拆分时不生成虚构隔墙', () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary: rectangle(0, 0, 12, 12), origin: [0, 0] }));
  const splits: RegionSplit[] = [{ regionId: 'r1', axis: 'x', ratio: 1 / 3 }, { regionId: 'r1.b', axis: 'x', ratio: 0.5 },
    { regionId: 'r1.b.a', axis: 'y', ratio: 1 / 3 }, { regionId: 'r1.b.a.b', axis: 'y', ratio: 0.5 }];
  const { model } = compileAllocation({ splits, allocations: [
    { id: 'open', usage: '开放训练区', regionIds: ['r1.a', 'r1.b.b', 'r1.b.a.a', 'r1.b.a.b.b'], enclosed: false },
    { id: 'room', usage: '私教室', regionIds: ['r1.b.a.b.a'], enclosed: true },
  ] }, catalog, 'rev-0001', true);
  assert.ok(model.spaces.length > 2);
  assert.equal(model.walls.length, 8);
  assert.deepEqual([...validateAgentModel(model).errors, ...validateLayoutCompleteness(model, true)], []);
});

test('修改保留固定墙和门窗宿主，不接受跨保留墙的封闭房间', () => {
  const parent = layoutModel();
  parent.walls.push({ id: 'fixed-partition', geometry: { type: 'polyline', points: [[5, 0], [5, 8]] }, fixed: true, height: 3, thickness: 0.12 });
  parent.openings = [{ id: 'entry', hostWallId: 'wall-0', position: 5, width: 1, height: 2.1 }];
  parent.doors = [{ id: 'door', openingId: 'entry', swing: 'none', analysisProperties: {} }];
  const catalog = createRegionCatalog(JSON.stringify({ boundary: parent.floor.boundary, origin: parent.model.origin }), parent);
  const allocations = [{ id: 'training', usage: '训练区', regionIds: catalog.regions.map((region) => region.id), enclosed: true }];
  assert.throws(() => compileAllocation({ allocations }, catalog, 'rev-0002'), /跨越保留墙/);
  allocations[0].enclosed = false;
  const { model } = compileAllocation({ allocations }, catalog, 'rev-0002');
  assert.deepEqual(model.walls.find((wall) => wall.id === 'fixed-partition'), parent.walls.at(-1));
  assert.deepEqual(model.walls.find((wall) => wall.id === 'wall-0'), parent.walls[0]);
  assert.deepEqual(model.openings, parent.openings);
  assert.deepEqual(model.doors, parent.doors);
});

test('毫米制区域仍以平方米分配面积，墙体尺寸按模型单位生成', () => {
  const catalog = createRegionCatalog(JSON.stringify({ boundary: rectangle(0, 0, 10000, 8000), origin: [0, 0], units: 'mm' }));
  assert.equal(catalog.regions[0].area, 80);
  const { model } = compileAllocation({ allocations: [{ id: 'training', usage: '训练区', enclosed: false, regionIds: ['r1'], minArea: 75 }] }, catalog, 'rev-0001');
  assert.equal(model.walls[0].thickness, 120);
  assert.deepEqual(validateModel(model).errors, []);
});
