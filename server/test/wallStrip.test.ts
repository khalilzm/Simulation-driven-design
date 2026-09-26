import { test } from 'node:test';
import assert from 'node:assert/strict';
import { centerlineWallPolygon, wallStripArea } from '@sdd/shared';

test('centerlineWallPolygon 直墙段面积等于长度×厚度', () => {
  const poly = centerlineWallPolygon([[0, 0], [10, 0]], 0.2);
  assert.ok(poly);
  assert.equal(wallStripArea([[0, 0], [10, 0]], 0.2), 2);
});

test('centerlineWallPolygon 折线墙转角仍闭合', () => {
  const poly = centerlineWallPolygon([[0, 0], [5, 0], [5, 5]], 0.24);
  assert.ok(poly);
  assert.ok(poly!.length >= 6);
  const area = wallStripArea([[0, 0], [5, 0], [5, 5]], 0.24);
  assert.ok(area > 5 * 0.24 + 5 * 0.24 - 0.5);
});

test('centerlineWallPolygon 无效输入返回 null', () => {
  assert.equal(centerlineWallPolygon([[0, 0]], 0.2), null);
  assert.equal(centerlineWallPolygon([[0, 0], [1, 0]], 0), null);
});
