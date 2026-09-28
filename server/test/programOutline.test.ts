import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProgramOutline, PROGRAM_OUTLINE_REL } from '../src/design/programOutline';
import { loadOutlineContext } from '../src/design/outlineContext';
import { buildOutlineJson } from '../src/spacePrompt';
import { rectangle } from './helpers/spaceModel';

test('parseProgramOutline 接受闭合矩形并规范 boundary', () => {
  const ring = rectangle(0, 0, 10, 8).slice(0, -1);
  const parsed = parseProgramOutline({ boundary: ring, origin: [0, 0], units: 'm', assumptions: ['约 80㎡'] });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const json = JSON.parse(parsed.outlineJson);
  assert.equal(json.units, 'm');
  assert.equal(json.bbox.area, 80);
  assert.deepEqual(json.assumptions, ['约 80㎡']);
});

test('parseProgramOutline 拒绝自交轮廓', () => {
  const bad = parseProgramOutline({
    boundary: [[0, 0], [10, 10], [10, 0], [0, 10]],
    origin: [0, 0],
    units: 'm',
  });
  assert.equal(bad.ok, false);
});

test('loadOutlineContext 读取 inputs/outline.json（program）', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-outline-program-'));
  const inputs = path.join(cwd, 'inputs');
  fs.mkdirSync(inputs, { recursive: true });
  const outlineJson = buildOutlineJson({
    boundary: rectangle(0, 0, 12, 6),
    origin: [0, 0],
    bbox: { width: 12, height: 6, area: 72 },
  });
  fs.writeFileSync(path.join(inputs, 'outline.json'), outlineJson);
  const ctx = loadOutlineContext(cwd, null);
  assert.equal(ctx.source, 'program');
  assert.ok(ctx.outline?.includes('"width":12'));
});

test('loadOutlineContext 有草图时不自动解析为轮廓', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-outline-sketch-'));
  const inputs = path.join(cwd, 'inputs');
  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, 'sketch.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const ctx = loadOutlineContext(cwd, null);
  assert.equal(ctx.source, 'none');
  assert.ok(ctx.inputHints?.includes('sketch.png'));
});

test('loadOutlineContext 不读取遗留 DXF 为固定轮廓', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-outline-no-dxf-'));
  const inputs = path.join(cwd, 'inputs');
  fs.mkdirSync(inputs, { recursive: true });
  fs.writeFileSync(path.join(inputs, 'legacy.dxf'), 'dummy');
  const ctx = loadOutlineContext(cwd, null);
  assert.equal(ctx.source, 'none');
  assert.equal(ctx.outline, undefined);
});

test('PROGRAM_OUTLINE_REL 路径固定', () => {
  assert.equal(PROGRAM_OUTLINE_REL, path.join('inputs', 'outline.json'));
});
