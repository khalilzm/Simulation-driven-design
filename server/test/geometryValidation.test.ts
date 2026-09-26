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
    '区域 r1 被重复分配',
  ]);
  assert.match(msg, /rev-0002/);
  assert.match(msg, /layout\.json/);
  assert.match(msg, /区域分配或切分/);
  assert.match(msg, /r1 被重复分配/);
});

test('filterGeometryValidationErrors 仅保留几何类错误', () => {
  const geom = filterGeometryValidationErrors([
    'space sp-1 边界边线穿出 floor 外轮廓',
    'opening op-1 的宿主墙不存在',
  ]);
  assert.equal(geom.length, 1);
  assert.equal(hasGeometryValidationErrors(geom), true);
});
