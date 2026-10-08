import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDxfFilename, isSketchFilename, listSketchInputHints } from '../src/design/inputHints';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('upload 区分 DXF 与常见草图扩展名', () => {
  assert.equal(isDxfFilename('plan.DXF'), true);
  assert.equal(isDxfFilename('photo.png'), false);
  assert.equal(isSketchFilename('sketch.png'), true);
  assert.equal(isSketchFilename('photo.JPG'), true);
  assert.equal(isSketchFilename('plan.dxf'), false);
});

test('listSketchInputHints 只列图片', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-hints-'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'b.dxf'), 'x');
  assert.equal(listSketchInputHints(dir), 'inputs/a.png');
});
