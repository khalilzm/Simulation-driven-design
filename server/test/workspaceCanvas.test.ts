import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CANVAS_MODULES, moduleShapeId, validateCanvasSnapshot } from '@sdd/shared';
import { loadCanvas, saveCanvas } from '../src/workbench/store';

const snapshot = () => ({ document: { store: Object.fromEntries(CANVAS_MODULES.map(module => [moduleShapeId(module), {
  id: moduleShapeId(module), type: 'module-board', props: { module, w: 320, h: 240 }, x: 40, y: 40,
}])) }, session: {} });

test('canvas allows a partial set of boards, and rejects duplicates or renamed module boards', () => {
  const valid = snapshot();
  assert.equal(validateCanvasSnapshot(valid), null);
  const missing = snapshot(); delete (missing.document.store as Record<string, unknown>)[moduleShapeId('metrics')];
  assert.equal(validateCanvasSnapshot(missing), null);
  const duplicate = snapshot();
  delete (duplicate.document.store as Record<string, unknown>)[moduleShapeId('metrics')];
  (duplicate.document.store as Record<string, unknown>)['shape:copy'] = { id: 'shape:copy', type: 'module-board', props: { module: 'dxf' } };
  assert.match(validateCanvasSnapshot(duplicate)!, /重复/);
  const renamed = snapshot();
  (renamed.document.store[moduleShapeId('dxf')] as { id: string }).id = 'shape:renamed';
  assert.match(validateCanvasSnapshot(renamed)!, /无效/);
  const annotated = snapshot();
  (annotated.document.store as Record<string, unknown>)['shape:note'] = { id: 'shape:note', type: 'text' };
  assert.equal(validateCanvasSnapshot(annotated), null);
});

test('canvas round-trips layout, guards paths, and preserves saved state after invalid writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-canvas-'));
  try {
    assert.equal(loadCanvas('session-one', root), null);
    const original = snapshot();
    original.document.store[moduleShapeId('dxf')].x = 268;
    saveCanvas('session-one', original, root);
    assert.deepEqual(loadCanvas('session-one', root)?.snapshot, original);
    assert.throws(() => saveCanvas('../escape', original, root), /标识/);
    assert.throws(() => saveCanvas('session-one', {}, root), /文档/);
    assert.deepEqual(loadCanvas('session-one', root)?.snapshot, original);
    assert.deepEqual(fs.readdirSync(path.join(root, 'session-one')), ['canvas.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
