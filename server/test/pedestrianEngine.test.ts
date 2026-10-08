import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { config, repoRoot } from '../src/config';

test('人流疏散 Python 回归', (t) => {
  const probe = spawnSync(config.pedestrianPython, ['-B', '-c', 'import jupedsim, pedpy, shapely'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('未安装 JuPedSim Python 环境；安装 server/python/pedestrian/requirements.txt 后运行');
    return;
  }
  const result = spawnSync(config.pedestrianPython,
    ['-B', '-m', 'unittest', 'discover', '-s', 'server/python/pedestrian/tests', '-v'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
