import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDroppedFile } from '@sdd/shared';

test('a dropped DXF is accepted by extension even when the browser omits a mime type', () => {
  assert.equal(classifyDroppedFile('house.dxf', ''), 'dxf');
  assert.equal(classifyDroppedFile('HOUSE.DXF', 'application/octet-stream'), 'dxf');
  assert.equal(classifyDroppedFile('plan.dxf', 'application/dxf'), 'dxf');
});

test('a dropped PNG, JPEG, or WebP image is accepted', () => {
  assert.equal(classifyDroppedFile('sketch.png', 'image/png'), 'image');
  assert.equal(classifyDroppedFile('photo.jpg', ''), 'image');
  assert.equal(classifyDroppedFile('photo.jpeg', 'image/jpeg'), 'image');
  assert.equal(classifyDroppedFile('scan.webp', 'image/webp'), 'image');
});

test('other dropped files are rejected', () => {
  assert.equal(classifyDroppedFile('notes.txt', 'text/plain'), null);
  assert.equal(classifyDroppedFile('model.dwg', ''), null);
});
