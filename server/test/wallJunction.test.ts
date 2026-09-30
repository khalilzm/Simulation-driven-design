import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWallJunctions,
  wallEndTrims,
  wallStripPolygon,
  type SpaceModel,
  type Vec2,
  type Wall,
} from '@sdd/shared';
import { resolveComponentDefaults } from '../src/model/resolveCatalog';

function wall(id: string, points: Vec2[], thickness = 0.2): Wall {
  return { id, geometry: { type: 'polyline', points }, thickness, height: 3, fixed: false };
}

function area(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

test('自由端：无接头时退化为 butt 平切，面积保持', () => {
  const w = wall('W', [[0, 0], [10, 0]]);
  const polys = resolveWallJunctions([w]);
  const wp = polys.get('W')!;
  assert.equal(wp.length, 4);
  assert.ok(Math.abs(area(wp) - 2.0) < 1e-9);
});

test('L 角接头：两面墙 miter 后无重叠，面积各自保持', () => {
  const w = wall('W', [[0, 0], [10, 0]]); // 东到 (10,0)
  const n = wall('N', [[10, -5], [10, 0]]); // 南到 (10,0)
  const polys = resolveWallJunctions([w, n]);
  assert.equal(polys.size, 2);
  assert.ok(Math.abs(area(polys.get('W')!) - 2.0) < 1e-9, 'W 面积 10×0.2');
  assert.ok(Math.abs(area(polys.get('N')!) - 1.0) < 1e-9, 'N 面积 5×0.2');
  // W 外角顶点 (10.1, 0.1)、内角顶点 (9.9, -0.1)
  const wp = polys.get('W')!;
  assert.ok(wp.some((p) => Math.abs(p[0] - 10.1) < 1e-9 && Math.abs(p[1] - 0.1) < 1e-9), 'W 外角 miter 顶点');
  assert.ok(wp.some((p) => Math.abs(p[0] - 9.9) < 1e-9 && Math.abs(p[1] + 0.1) < 1e-9), 'W 内角 miter 顶点');
});

test('L 角接头（链式 end+start）：两墙共享角平分线边，无重叠无缝隙', () => {
  const w = wall('W', [[0, 0], [10, 0]]); // 东墙，终点 (10,0)
  const n = wall('N', [[10, 0], [10, 5]]); // 北墙，起点 (10,0)
  const polys = resolveWallJunctions([w, n]);
  const wp = polys.get('W')!;
  const np = polys.get('N')!;
  assert.ok(Math.abs(area(wp) - 2.0) < 1e-9, 'W 面积');
  assert.ok(Math.abs(area(np) - 1.0) < 1e-9, 'N 面积');
  // 两墙共用的内角 (9.9, 0.1) 与外角 (10.1, -0.1) 顶点
  for (const poly of [wp, np]) {
    assert.ok(poly.some((p) => Math.abs(p[0] - 9.9) < 1e-9 && Math.abs(p[1] - 0.1) < 1e-9), '内角 miter 顶点');
    assert.ok(poly.some((p) => Math.abs(p[0] - 10.1) < 1e-9 && Math.abs(p[1] + 0.1) < 1e-9), '外角 miter 顶点');
  }
});

test('T 接接头：支墙回退到主墙外表面', () => {
  const w = wall('W', [[0, 0], [5, 0]]); // 支墙，末端落在 N 内部
  const n = wall('N', [[5, -5], [5, 5]], 0.4); // 主墙，半厚 0.2
  const polys = resolveWallJunctions([w, n]);
  const wp = polys.get('W')!;
  const maxX = Math.max(...wp.map((p) => p[0]));
  assert.ok(Math.abs(maxX - 4.8) < 1e-9, '支墙末端回退到 x=4.8');
});

test('wallEndTrims 识别角接 / T 接 / 自由端', () => {
  const w = wall('W', [[0, 0], [5, 0]]);
  const corner = wall('C', [[0, 0], [0, 3]]); // 与 W 起点角接
  const tee = wall('T', [[5, -3], [5, 3]]); // W 终点落在 T 内部
  assert.equal(wallEndTrims(w, [w, corner, tee]).start.kind, 'miter');
  assert.equal(wallEndTrims(w, [w, corner, tee]).end.kind, 'flush');
  assert.equal(wallEndTrims(w, [w]).start.kind, 'butt');
});

test('共线续接退化为 butt（不 miter）', () => {
  const w = wall('W', [[0, 0], [5, 0]]);
  const cont = wall('C', [[5, 0], [10, 0]]); // 与 W 共线续接
  assert.equal(wallEndTrims(w, [w, cont]).end.kind, 'butt');
});

test('承重墙 typeId 解析为 structural 且默认 fixed，隔墙为 partition', () => {
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], elevation: 0, height: 3, topObstruction: false, bottomObstruction: false },
    walls: [
      { id: 'w1', geometry: { type: 'polyline', points: [[0, 0], [5, 0]] }, thickness: 0.1, height: 3, fixed: false, analysisProperties: { typeId: 'wall-shear-300' } },
      { id: 'w2', geometry: { type: 'polyline', points: [[0, 5], [5, 5]] }, thickness: 0.1, height: 3, fixed: false, analysisProperties: { typeId: 'wall-int-200' } },
    ],
    openings: [], doors: [], windows: [], spaces: [], fixedContext: [], externalContext: [],
  };
  resolveComponentDefaults(model);
  const structural = model.walls.find((w) => w.id === 'w1')!;
  const partition = model.walls.find((w) => w.id === 'w2')!;
  assert.equal(structural.role, 'structural');
  assert.equal(structural.fixed, true, '承重墙默认 fixed');
  assert.equal(structural.thickness, 0.3, '承重墙300 默认厚度');
  assert.equal(partition.role, 'partition');
  assert.equal(partition.fixed, false);
  assert.equal(partition.thickness, 0.2, '内隔墙200 默认厚度');
});
