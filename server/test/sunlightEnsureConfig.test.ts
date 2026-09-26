import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureSunlightConfig, defaultSunlightTemplatePath } from '../src/sunlight/ensureConfig';

test('ensureSunlightConfig 从示例模板创建 sunlight.json', () => {
  assert.ok(fs.existsSync(defaultSunlightTemplatePath()));
  const dir = path.join('/tmp', `sdd-sun-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'sunlight.json');
  const first = ensureSunlightConfig(configPath);
  assert.equal(first.created, true);
  assert.ok(fs.existsSync(configPath));
  const second = ensureSunlightConfig(configPath);
  assert.equal(second.created, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
