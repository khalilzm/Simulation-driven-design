import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config, repoRoot, sunlightProcessEnv } from '../src/config';

test('日照 Python 物理、时区与面积统计回归', (t) => {
  const probe = spawnSync(config.sunlightPython, ['-B', '-c', 'import ladybug, honeybee, honeybee_radiance'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('未安装 Ladybug/Honeybee Python 环境；安装 server/python/sunlight/requirements.txt 后运行');
    return;
  }
  const result = spawnSync(config.sunlightPython,
    ['-B', '-m', 'unittest', 'discover', '-s', 'server/python/sunlight/tests', '-v'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000,
      env: { ...sunlightProcessEnv(), PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
