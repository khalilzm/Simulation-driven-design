import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceModel, Vec2 } from '@sdd/shared';
import { OUTSIDE, buildSpatialGraph, reachableFrom, unreachableSpaces } from '../src/geometry/spatialGraph';

function rect(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

function wall(id: string, points: Vec2[], opts: Partial<SpaceModel['walls'][number]> = {}): SpaceModel['walls'][number] {
  return { id, geometry: { type: 'polyline', points }, thickness: 0.2, height: 3, fixed: false, ...opts };
}

/** 两房共隔墙（中心线 x=10），含内门、外门、外窗。 */
function twoRoom(): SpaceModel {
  return {
    model: { schemaVersion: '1', revisionId: 'r', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: rect(0, 0, 20, 10), elevation: 0, height: 3, topObstruction: true, bottomObstruction: true },
    spaceTypes: [{ id: 't', label: '房', color: '#A8C8F0' }],
    spaces: [
      { id: 'roomA', allocationId: 'roomA', typeId: 't', usage: 'A', targetArea: 100, enclosed: true, boundary: rect(0, 0, 10, 10), performancePreferences: {} },
      { id: 'roomB', allocationId: 'roomB', typeId: 't', usage: 'B', targetArea: 100, enclosed: true, boundary: rect(10, 0, 20, 10), performancePreferences: {} },
    ],
    walls: [
      wall('partition', [[10, 0], [10, 10]], { role: 'partition' }),
      wall('outer-left', [[0, 0], [0, 10]], { fixed: true }),
      wall('outer-right', [[20, 0], [20, 10]], { fixed: true }),
      wall('outer-top', [[0, 10], [20, 10]], { fixed: true }),
      wall('outer-bottom', [[0, 0], [20, 0]], { fixed: true }),
    ],
    openings: [
      { id: 'door-open', hostWallId: 'partition', position: 5, width: 0.8, height: 2.1, sillHeight: 0 },
      { id: 'exit-open', hostWallId: 'outer-left', position: 5, width: 1.2, height: 2.1, sillHeight: 0 },
      { id: 'win-open', hostWallId: 'outer-right', position: 5, width: 2, height: 1.4, sillHeight: 0.8 },
    ],
    doors: [
      { id: 'door-d', openingId: 'door-open', swing: 'none', analysisProperties: {} },
      { id: 'door-e', openingId: 'exit-open', swing: 'none', analysisProperties: {} },
    ],
    windows: [{ id: 'win', openingId: 'win-open', analysisProperties: {} }],
    fixedContext: [],
    externalContext: [],
  };
}

test('派生节点与四类边（相邻/门/窗/锁定）', () => {
  const graph = buildSpatialGraph(twoRoom());
  assert.deepEqual(graph.nodes.map((n) => n.id).sort(), ['outside', 'roomA', 'roomB'].sort());

  const adj = graph.edges.find((e) => e.kind === 'adjacency');
  assert.ok(adj, '应有相邻边');
  assert.equal(adj.wallId, 'partition');
  assert.equal(adj.locked, false);
  assert.deepEqual(new Set([adj.from, adj.to]), new Set(['roomA', 'roomB']));

  const doorAB = graph.edges.find((e) => e.id === 'door-door-open');
  assert.ok(doorAB);
  assert.equal(doorAB.kind, 'door');
  assert.equal(doorAB.netWidthM, 0.8);
  assert.equal(doorAB.doorId, 'door-d');

  const exit = graph.edges.find((e) => e.id === 'door-exit-open');
  assert.ok(exit);
  assert.equal(exit.locked, true, '外门宿主墙 fixed，应锁定');
  assert.ok([exit.from, exit.to].includes(OUTSIDE));

  const win = graph.edges.find((e) => e.id === 'win-win-open');
  assert.ok(win);
  assert.equal(win.kind, 'window');
  assert.ok([win.from, win.to].includes(OUTSIDE));
});

test('可达性：外门连通全屋', () => {
  const graph = buildSpatialGraph(twoRoom());
  const reached = reachableFrom(graph, [OUTSIDE]);
  assert.ok(reached.has('roomA'));
  assert.ok(reached.has('roomB'));
  assert.deepEqual(unreachableSpaces(graph), []);
});

test('封闭且无通路的房间不可达', () => {
  const model = twoRoom();
  model.spaces.push({ id: 'roomC', allocationId: 'roomC', typeId: 't', usage: 'C', targetArea: 40, enclosed: true, boundary: rect(2, 2, 6, 6), performancePreferences: {} });
  const graph = buildSpatialGraph(model);
  assert.deepEqual(unreachableSpaces(graph), ['roomC']);
});
