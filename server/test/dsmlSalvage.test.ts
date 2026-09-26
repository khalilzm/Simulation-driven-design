import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractDsmlWrite, normalizeAgentModel, salvageDsmlToRevision } from '../src/providers/dsmlSalvage';

const sampleSession = path.resolve(
  import.meta.dirname,
  '../../workspaces/9f715aad-df9d-444c-ad20-9ccf9b007c9b/session.json',
);

test('extractDsmlWrite 解析 Write 内容', () => {
  const session = JSON.parse(fs.readFileSync(sampleSession, 'utf8'));
  const text = session.messages[1].content as string;
  const extracted = extractDsmlWrite(text);
  assert.ok(extracted);
  assert.match(extracted.filePath, /model\.json$/);
  assert.match(extracted.content, /"spaces"/);
});

test('normalizeAgentModel 仅用于内存解析，规整 wall.points 字段', () => {
  const raw = {
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: [[0, 0], [10, 0], [10, 8], [0, 8], [0, 0]],
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    walls: [
      { id: 'wall-int-01', fixed: false, points: [[5, 0], [5, 8]], thickness: 0.2, height: 3 },
    ],
    spaces: [],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };
  const model = normalizeAgentModel(raw, 'rev-0001');
  assert.ok(model);
  assert.equal(model.walls[0].geometry.points.length, 2);
});

test('salvageDsmlToRevision 原样写入 Agent JSON，不做规整', () => {
  const session = JSON.parse(fs.readFileSync(sampleSession, 'utf8'));
  const text = session.messages[1].content as string;
  const extracted = extractDsmlWrite(text)!;
  const tmp = fs.mkdtempSync(path.join(import.meta.dirname, '../.tmp-salvage-'));
  const ok = salvageDsmlToRevision(text, tmp, 'rev-0001');
  assert.equal(ok, true);
  const file = path.join(tmp, 'designs', 'rev-0001', 'model.json');
  assert.ok(fs.existsSync(file));
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  const raw = JSON.parse(extracted.content);
  assert.deepEqual(written, raw);
  fs.rmSync(tmp, { recursive: true, force: true });
});
