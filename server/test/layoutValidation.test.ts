import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLayoutCompleteness } from '../src/model/layoutValidation';
import { validateAgentModel } from '../src/model/validateAgent';
import { layoutModel, rectangle } from './helpers/spaceModel';

test('相邻开放功能区无需内隔墙；拆段及反向外墙共同覆盖外轮廓', () => {
  const model = layoutModel();
  model.spaces[0].boundary = rectangle(0, 0, 5, 8);
  model.spaces.push({ ...model.spaces[0], id: 'training-2', boundary: rectangle(5, 0, 10, 8) });
  model.walls[0].geometry.points = [[5, 0], [0, 0]];
  model.walls.push({ ...model.walls[0], id: 'wall-split', geometry: { type: 'polyline', points: [[10, 0], [5, 0]] } });
  assert.deepEqual(validateLayoutCompleteness(model, true), []);
});

test('外墙中间的漏段会返回准确坐标', () => {
  const model = layoutModel();
  model.walls[0].geometry.points = [[0, 0], [4, 0]];
  model.walls.push({ ...model.walls[0], id: 'wall-split', geometry: { type: 'polyline', points: [[6, 0], [10, 0]] } });
  assert.deepEqual(validateLayoutCompleteness(model), ['外轮廓缺墙：[4,0]→[6,0]，补墙中心线（允许多段共线墙覆盖）']);
});

test('重叠抵消面积不能掩盖未覆盖区域', () => {
  const model = layoutModel();
  // 两块各 40 m²，但完全重叠，右半层仍有 40 m² 未覆盖。
  model.spaces[0].boundary = rectangle(0, 0, 5, 8);
  model.spaces.push({ ...model.spaces[0], id: 'duplicate' });
  assert.ok(validateAgentModel(model).errors.some((error) => error.includes('区域重叠')));
  assert.ok(validateLayoutCompleteness(model, true).some((error) => error.includes('40.0000 m² 未分配')));
  assert.deepEqual(validateLayoutCompleteness(model, false), []);
});

test('覆盖检查识别内部孔洞、多个漏区和完整凹轮廓', () => {
  const model = layoutModel();
  model.spaces[0].boundary = rectangle(2, 2, 8, 6);
  assert.ok(validateLayoutCompleteness(model, true).some((error) => error.includes('56.0000 m² 未分配')));
  model.spaces[0].boundary = rectangle(4, 0, 6, 8);
  assert.ok(validateLayoutCompleteness(model, true).some((error) => error.includes('64.0000 m² 未分配')));
  const boundary: typeof model.floor.boundary = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 8], [0, 8], [0, 0]];
  model.floor.boundary = boundary;
  model.spaces[0].boundary = boundary;
  model.walls = [{ ...model.walls[0], geometry: { type: 'polyline', points: boundary } }];
  assert.deepEqual(validateLayoutCompleteness(model, true), []);
});
