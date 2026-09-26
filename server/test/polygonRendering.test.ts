import { test } from 'node:test';
import assert from 'node:assert/strict';
import earcut, { deviation } from 'earcut';
import { polygonGeometryError, type SpaceModel, type Vec2 } from '@sdd/shared';
import { findBoundaryOutside } from '@sdd/shared';
import { polygonArea } from '../src/model/geometry';
import { validateModel } from '../src/model/validate';
import { modelToSpaceFills, modelToWallFills, modelToLineGroups } from '../../web/src/viewer/modelRender';
import { triangulatePolygonEarcut } from '../../web/src/viewer/polygonMesh';

const screenshotFloor: Vec2[] = [
  [0,14.515],[0,1.459],[28.751,1.459],[28.751,0],[32.092,0],[32.092,1.459],
  [38.794,1.459],[38.794,6.707],[39.973,6.707],[39.973,10.795],[38.804,10.795],
  [38.804,29.446],[25.831,29.446],[25.831,26.228],[24.332,26.228],[24.332,21.084],
  [25.861,21.084],[25.861,20.703],[25.861,19.557],[25.861,18.838],[24.648,18.838],
  [24.648,16.547],[25.831,16.547],[25.831,16.165],[30.643,16.165],[30.643,14.442],
  [30.39,14.442],[29.194,14.442],[23.237,14.442],[23.237,15.837],[19.002,15.837],
  [19.002,14.441],[18.342,14.441],[17.14,14.441],[16.556,14.441],[16.556,16.1],
  [8.413,16.1],[8.413,14.441],[7.893,14.441],[6.697,14.441],[6.077,14.441],
  [6.077,15.667],[3.139,15.667],[3.139,14.471],[0,14.515],
];
const crossedOffice: Vec2[] = [
  [6.5,14.2],[16.556,14.441],[19.002,14.441],[19.002,15.837],[23.237,15.837],
  [23.237,14.442],[29.194,14.442],[30.643,14.442],[30.643,16.165],[25.831,16.165],
  [25.831,16.547],[24.648,16.547],[24.648,18.838],[25.861,18.838],[25.861,21.084],
  [24.332,21.084],[24.332,26.228],[24.2,26.3],[24.2,14.2],[6.5,14.2],
];
const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] =>
  [[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]];

function modelFor(floor: Vec2[], spaces: Vec2[][]): SpaceModel {
  return {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0,0] },
    floor: { boundary: floor, elevation: 0, height: 3, topObstruction: false, bottomObstruction: false },
    spaceTypes: [{ id: 'office', label: '开放办公', color: '#88C8E8' }],
    spaces: spaces.map((boundary, i) => ({ id: `space-${i}`, boundary, typeId: 'office', usage: '开放办公', targetArea: 0, performancePreferences: {} })),
    walls: [], openings: [], doors: [], windows: [], fixedContext: [], externalContext: [],
  };
}

test('自交办公边界不得进入 Earcut 填充', () => {
  assert.ok(polygonArea(crossedOffice) > 8);
  const flat = crossedOffice.slice(0, -1).flat();
  assert.ok(deviation(flat, [], 2, earcut(flat)) > 7);
  assert.match(polygonGeometryError(crossedOffice) ?? '', /自交/);
  assert.equal(triangulatePolygonEarcut(crossedOffice), null);

  const model = modelFor(screenshotFloor, [crossedOffice, rect(6.5,9.5,11,14.2)]);
  const fills = modelToSpaceFills(model);
  assert.deepEqual(fills.map((f) => f.spaceId), [undefined, 'space-1']);
  assert.ok(validateModel(model).errors.some((e) => e.includes('space-0') && e.includes('自交')));
});

test('合法凹多边形顺逆时针均保持面积', () => {
  const lShape: Vec2[] = [[0,0],[8,0],[8,3],[3,3],[3,8],[0,8],[0,0]];
  for (const boundary of [lShape, lShape.slice().reverse()]) {
    assert.equal(polygonGeometryError(boundary), null);
    const mesh = triangulatePolygonEarcut(boundary);
    assert.ok(mesh);
    let area = 0;
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const triangle: Vec2[] = Array.from(mesh.indices.slice(i, i + 3), (j) => [mesh.positions[j * 3], mesh.positions[j * 3 + 1]] as Vec2);
      triangle.push(triangle[0]);
      area += polygonArea(triangle);
      assert.equal(findBoundaryOutside(triangle, boundary), null);
    }
    assert.ok(Math.abs(area - 39) < 1e-6);
    assert.equal(modelToSpaceFills(modelFor(boundary, [boundary])).length, 2);
  }
});

test('越界空间 viewer 仍填充，但 validateModel 会报错', () => {
  const floor: Vec2[] = [[0,0],[10,0],[10,10],[3,10],[3,4],[2,4],[2,10],[0,10],[0,0]];
  const room = rect(1,5,9,6);
  const model = modelFor(floor, [room]);
  const fills = modelToSpaceFills(model);
  assert.equal(fills.length, 2);
  assert.equal(validateModel(model).valid, false);
  assert.ok(validateModel(model).errors.some((e) => e.includes('穿出') || e.includes('超出')));
});

test('墙体填充真正扣除门洞，门符号与洞宽一致且功能区不描闭合实线', () => {
  const model = modelFor(rect(0, 0, 10, 8), [rect(0, 0, 10, 8)]);
  model.walls = [{ id: 'wall', geometry: { type: 'polyline', points: [[0, 0], [5, 0], [5, 5]] }, thickness: 0.2, height: 3, fixed: false }];
  model.openings = [{ id: 'door-opening', hostWallId: 'wall', position: 2.5, width: 1, height: 2.1 },
    { id: 'window-opening', hostWallId: 'wall', position: 7.5, width: 2, height: 1.2 }];
  model.doors = [{ id: 'door', openingId: 'door-opening', swing: 'none', analysisProperties: {} }];
  model.windows = [{ id: 'window', openingId: 'window-opening', analysisProperties: {} }];
  const fills = modelToWallFills(model);
  assert.equal(fills.length, 3);
  const area = fills.reduce((total, fill) => total + Array.from({ length: fill.mesh.indices.length / 3 }, (_, i) => {
    const points: Vec2[] = Array.from(fill.mesh.indices.slice(i * 3, i * 3 + 3), (j) => [fill.mesh.positions[j * 3], fill.mesh.positions[j * 3 + 1]] as Vec2);
    points.push(points[0]); return polygonArea(points);
  }).reduce((sum, part) => sum + part, 0), 0);
  assert.ok(Math.abs(area - 1.4) < 1e-5);
  model.spaces[0].enclosed = false;
  assert.equal(modelToLineGroups(model).length, 2);
  const positions = modelToLineGroups(model)[1].positions;
  assert.deepEqual(positions.slice(0, 6), [2, -0.1, 0, 2, 0.1, 0]);
});
