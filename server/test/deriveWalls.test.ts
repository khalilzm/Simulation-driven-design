import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePolygon } from '../src/model/geometry';
import { deriveWallsIfEmpty, interiorWallsFromSpaces, wallsFromPlanarGraph } from '../src/model/deriveWalls';
import { inferSpaceTypes } from '../src/model/inferSpaceTypes';
import { exteriorWallsFromBoundary } from '../src/model/exteriorWalls';
import { finalizeAgentModel } from '../src/model/finalizeModel';
import { validateAgentModel } from '../src/model/validateAgent';
import { validateModel } from '../src/model/validate';

test('DFS 合并共线墙段为一条 polyline', () => {
  const floor = closePolygon([[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]]);
  const spaces = [
    { id: 'a', boundary: closePolygon([[0, 0], [4, 0], [4, 8], [0, 8], [0, 0]]) },
    { id: 'b', boundary: closePolygon([[4, 0], [8, 0], [8, 8], [4, 8], [4, 0]]) },
    { id: 'c', boundary: closePolygon([[8, 0], [12, 0], [12, 8], [8, 8], [8, 0]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(pts.some((p) => p[0] === 4));
  assert.ok(pts.some((p) => p[0] === 8));
  assert.ok(walls.every((w) => w.thickness === 0.12));
});

test('共享边生成隔墙，外轮廓同样生成墙', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const spaces = [
    { id: 'sp-1', boundary: closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]) },
    { id: 'sp-2', boundary: closePolygon([[5, 0], [10, 0], [10, 8], [5, 8], [5, 0]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  assert.ok(walls.length >= 5);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(pts.some((p) => p[0] === 5));
});

test('exteriorWallsFromBoundary 沿轮廓生成 fixed 外墙', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const walls = exteriorWallsFromBoundary(floor, 3);
  assert.equal(walls.length, 4);
  assert.ok(walls.every((w) => w.fixed === true));
});

test('finalizeAgentModel 保留 Agent 墙体并通过完整校验', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const agentWalls = [
    { id: 'wall-1', geometry: { type: 'polyline', points: [[0, 0], [10, 0]] }, thickness: 0.12, height: 3, fixed: false },
    { id: 'wall-2', geometry: { type: 'polyline', points: [[10, 0], [10, 8]] }, thickness: 0.12, height: 3, fixed: false },
    { id: 'wall-3', geometry: { type: 'polyline', points: [[10, 8], [0, 8]] }, thickness: 0.12, height: 3, fixed: false },
    { id: 'wall-4', geometry: { type: 'polyline', points: [[0, 8], [0, 0]] }, thickness: 0.12, height: 3, fixed: false },
    { id: 'wall-5', geometry: { type: 'polyline', points: [[6, 0], [6, 8]] }, thickness: 0.12, height: 3, fixed: false },
  ];
  const raw = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: floor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [
      { id: 'office', label: '办公', color: '#A8C8F0' },
      { id: 'meeting', label: '会议', color: '#FFE4A8' },
    ],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'office',
        usage: '办公区',
        boundary: closePolygon([[0, 0], [6, 0], [6, 8], [0, 8], [0, 0]]),
        targetArea: 48,
        performancePreferences: {},
      },
      {
        id: 'sp-2',
        typeId: 'meeting',
        usage: '会议室',
        boundary: closePolygon([[6, 0], [10, 0], [10, 8], [6, 8], [6, 0]]),
        targetArea: 32,
        performancePreferences: {},
      },
    ],
    walls: agentWalls,
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
  assert.equal(validateAgentModel(raw).valid, true);
  const finalized = finalizeAgentModel(raw, 'rev-0001');
  assert.equal(finalized.walls.length, 5);
  assert.equal(finalized.walls[4].id, 'wall-5');
  assert.equal(validateModel(finalized).valid, true);
});

test('未划分 void 区域边界进入平面图并生成墙', () => {
  const floor = closePolygon([[0, 0], [12, 0], [12, 8], [0, 8], [0, 0]]);
  const spaces = [
    { id: 'a', boundary: closePolygon([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]) },
    { id: 'b', boundary: closePolygon([[8, 0], [12, 0], [12, 4], [8, 4], [8, 0]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(
    pts.some((p) => p[1] === 4 && p[0] >= 4 && p[0] <= 8),
    'void 北侧边界应生成墙',
  );
  assert.ok(
    pts.some((p) => p[0] === 4 && p[1] <= 4),
    'void 西侧边界应生成墙',
  );
});

test('floor 上半未划 space 时 void 与下方 space 之间生成墙', () => {
  const floor = closePolygon([[0, 0], [12, 0], [12, 9], [0, 9], [0, 0]]);
  const spaces = [
    { id: 'lower', boundary: closePolygon([[0, 0], [12, 0], [12, 4], [0, 4], [0, 0]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(
    pts.some((p) => p[1] === 4 && p[0] >= 0 && p[0] <= 12),
    'void 与下层 space 之间应有横墙',
  );
});

test('统一平面图：floor+spaces 共边无向，隔墙只生成一条', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const spaces = [
    { id: 'sp-1', boundary: closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]) },
    { id: 'sp-2', boundary: closePolygon([[5, 0], [10, 0], [10, 8], [5, 8], [5, 0]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  assert.equal(walls.length, 5);
  const partition = walls.find((w) => w.geometry.points.some((p) => p[0] === 5));
  assert.ok(partition);
  assert.equal(partition!.geometry.points.length, 2);
});

test('统一平面图：住宅分区生成完整墙网', () => {
  const floor = closePolygon([[0, 0], [12, 0], [12, 9], [0, 9], [0, 0]]);
  const spaces = [
    { id: 'space-1', boundary: closePolygon([[0, 0], [7, 0], [7, 4.5], [0, 4.5], [0, 0]]) },
    { id: 'space-2', boundary: closePolygon([[7, 0], [12, 0], [12, 4.5], [7, 4.5], [7, 0]]) },
    { id: 'space-3', boundary: closePolygon([[0, 4.5], [12, 4.5], [12, 5.5], [0, 5.5], [0, 4.5]]) },
    { id: 'space-4', boundary: closePolygon([[0, 5.5], [4.4, 5.5], [4.4, 9], [0, 9], [0, 5.5]]) },
    { id: 'space-5', boundary: closePolygon([[4.4, 5.5], [8, 5.5], [8, 9], [4.4, 9], [4.4, 5.5]]) },
    { id: 'space-6', boundary: closePolygon([[8, 5.5], [10.5, 5.5], [10.5, 9], [8, 9], [8, 5.5]]) },
    { id: 'space-7', boundary: closePolygon([[10.5, 5.5], [12, 5.5], [12, 9], [10.5, 9], [10.5, 5.5]]) },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  assert.ok(walls.length >= 10);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(pts.some((p) => p[0] === 7 && p[1] <= 4.5), '客厅|餐厨竖墙');
  assert.ok(pts.some((p) => p[1] === 4.5), '走廊南侧横墙');
});

test('C 形开放办公 + 内嵌小房间：非外轮廓边均生成墙', () => {
  const floor = closePolygon([
    [0, 0], [12, 0], [12, 10], [0, 10], [0, 0],
  ]);
  const spaces = [
    { id: 'meeting', boundary: closePolygon([[0, 4], [4, 4], [4, 8], [0, 8], [0, 4]]) },
    { id: 'office-a', boundary: closePolygon([[0, 8], [2, 8], [2, 10], [0, 10], [0, 8]]) },
    { id: 'office-b', boundary: closePolygon([[2, 8], [4, 8], [4, 10], [2, 10], [2, 8]]) },
    {
      id: 'open',
      boundary: closePolygon([
        [4, 0], [12, 0], [12, 10], [4, 10], [4, 8], [4, 4], [4, 0],
      ]),
    },
  ];
  const walls = wallsFromPlanarGraph(floor, spaces, 3);
  const pts = walls.flatMap((w) => w.geometry.points);
  assert.ok(pts.some((p) => p[0] === 2 && p[1] >= 8), 'office-a | office-b 竖墙');
  assert.ok(pts.some((p) => p[1] === 8 && p[0] <= 4), 'meeting | office 横墙');
  assert.ok(pts.some((p) => p[0] === 4 && p[1] >= 4), 'meeting | open 竖墙');
});

test('inferSpaceTypes 从 usage 补全缺失的 spaceTypes', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const model = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: floor, elevation: 0, height: 3, topObstruction: false, bottomObstruction: false },
    spaces: [
      {
        id: 'sp-1',
        typeId: '',
        boundary: closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]),
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
  } as import('@sdd/shared').SpaceModel;
  inferSpaceTypes(model);
  assert.ok(model.spaceTypes?.length);
  assert.equal(model.spaces[0].typeId, model.spaceTypes![0].id);
});

test('deriveWallsIfEmpty 不再后处理派生墙体', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const model = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [0, 0] },
    floor: { boundary: floor, elevation: 0, height: 3, topObstruction: false, bottomObstruction: false },
    spaceTypes: [{ id: 'a', label: 'A', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'a',
        boundary: closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]),
        usage: 'A',
        targetArea: 40,
        performancePreferences: {},
      },
      {
        id: 'sp-2',
        typeId: 'a',
        boundary: closePolygon([[5, 0], [10, 0], [10, 8], [5, 8], [5, 0]]),
        usage: 'B',
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
  } as import('@sdd/shared').SpaceModel;
  const out = deriveWallsIfEmpty(model);
  assert.equal(out.walls.length, 0);
});

test('validateAgentModel 拒绝有 spaces 但无 walls', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const raw = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: floor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'a', label: 'A', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-1',
        typeId: 'a',
        usage: 'A区',
        boundary: closePolygon([[0, 0], [5, 0], [5, 8], [0, 8], [0, 0]]),
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
  };
  const v = validateAgentModel(raw);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('walls')));
});

test('validateAgentModel 允许未贴分割线的 space 边（只要在轮廓内）', () => {
  const floor = closePolygon([[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]]);
  const raw = {
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
        id: 'sp-bad-partition',
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
  };
  assert.equal(validateAgentModel(raw).valid, true);
});
