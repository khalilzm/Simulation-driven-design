import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractDxfOutline } from '../src/dxf/outline';
import { normalizePolygon } from '../src/geometry/polygon';
import { buildOutlineJson } from '../src/spacePrompt';
import type { Vec2 } from '@sdd/shared';

const sampleDxf = path.resolve(
  import.meta.dirname,
  '../../workspaces/ccafb143-65ef-4cf3-bd2b-e3a7ae2804cd/inputs/_.dxf',
);

test('DXF 外轮廓归一化到原点', () => {
  const text = fs.readFileSync(sampleDxf, 'utf8');
  const parsed = extractDxfOutline(text);
  assert.ok(parsed);
  const xs = parsed.boundary.map((p) => p[0]);
  const ys = parsed.boundary.map((p) => p[1]);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.min(...ys), 0);
  assert.ok(parsed.bbox.width > 0);
  assert.ok(parsed.bbox.area > 0);
  assert.ok(parsed.origin[0] > 1e5);
});

test('normalizePolygon 平移并保留精度', () => {
  const { boundary, origin } = normalizePolygon([[100.12345, 200.98765], [103.1, 200.98765], [103.1, 203.2]]);
  assert.deepEqual(origin, [100.12345, 200.98765]);
  assert.deepEqual(boundary[0], [0, 0]);
});

test('buildOutlineJson 补齐闭合点且不附带外墙段', () => {
  const boundary: Vec2[] = [[0, 0], [10, 0], [10, 8], [4, 8], [4, 4], [0, 4]];
  const original = structuredClone(boundary);
  const origin: Vec2 = [100, 200];
  const outline = buildOutlineJson({ boundary, origin, bbox: { width: 10, height: 8, area: 64 } });
  const parsed = JSON.parse(outline);
  assert.deepEqual(boundary, original);
  assert.deepEqual(parsed.boundary, [...original, original[0]]);
  assert.equal(parsed.exteriorWalls, undefined);
  assert.ok(parsed.bbox);

  const closedAgain = JSON.parse(buildOutlineJson(parsed));
  assert.deepEqual(closedAgain, parsed);
});
