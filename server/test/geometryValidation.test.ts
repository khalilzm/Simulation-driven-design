import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterGeometryValidationErrors,
  hasGeometryValidationErrors,
  isGeometryValidationError,
} from '../src/model/geometryValidation';
import { buildValidationCorrectionMessage } from '../src/spacePrompt';

test('isGeometryValidationError 识别可修正的几何错误', () => {
  assert.equal(isGeometryValidationError('space sp-1 边界边线穿出 floor 外轮廓'), true);
  assert.equal(isGeometryValidationError('opening op-1 position 超出墙'), false);
});

test('buildValidationCorrectionMessage 包含错误与修正指引', () => {
  const msg = buildValidationCorrectionMessage('rev-0002', [
    'space sp-1 边界顶点超出 floor 外轮廓',
  ]);
  assert.match(msg, /rev-0002/);
  assert.match(msg, /只改报错涉及的字段/);
  assert.match(msg, /floor\.boundary 勿动/);
  assert.match(msg, /sp-1/);
});

test('filterGeometryValidationErrors 仅保留几何类错误', () => {
  const geom = filterGeometryValidationErrors([
    'space sp-1 边界边线穿出 floor 外轮廓',
    'opening op-1 的宿主墙不存在',
  ]);
  assert.equal(geom.length, 1);
  assert.equal(hasGeometryValidationErrors(geom), true);
});
