import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAgentLayoutFile, findMisplacedLayoutFile, layoutRelativePath } from '../src/design/resolveAgentLayout';

test('findMisplacedLayoutFile 发现工作区外同 revision 的 layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-layout-salvage-'));
  const cwd = path.join(root, 'workspaces', 'session-a');
  const misplaced = path.join(root, 'designs', 'rev-0001', 'layout.json');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(misplaced), { recursive: true });
  fs.writeFileSync(misplaced, '{"schemaVersion":2}');
  assert.equal(findMisplacedLayoutFile(cwd, 'rev-0001'), misplaced);
  assert.equal(ensureAgentLayoutFile(cwd, 'rev-0001').ok, true);
  assert.equal(fs.readFileSync(path.join(cwd, layoutRelativePath('rev-0001')), 'utf8'), '{"schemaVersion":2}');
  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureAgentLayoutFile 无文件时返回明确 reason', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-layout-missing-'));
  const out = ensureAgentLayoutFile(cwd, 'rev-0002');
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.reason, /rev-0002/);
  fs.rmSync(cwd, { recursive: true, force: true });
});
