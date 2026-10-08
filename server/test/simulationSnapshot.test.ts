import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { config, workspacesDir } from '../src/config';
import { runSunlightAnalysis } from '../src/sunlight/run';
import { runPedestrianAnalysis } from '../src/pedestrian/run';
import { optimizationModel, optimizationSunlight, optimizationPedestrian } from './helpers/optimization';

test('两运行器只读取冻结输入，即使旧调用传入不存在的可变文件路径（模拟求解器）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-frozen-input-'));
  const sessionId = `snapshot-test-${randomUUID()}`;
  const original = { sun: config.sunlightPython, ped: config.pedestrianPython };
  t.after(() => {
    config.sunlightPython = original.sun; config.pedestrianPython = original.ped;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(workspacesDir, sessionId), { recursive: true, force: true });
  });
  const stub = path.join(dir, 'fake-python');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const arg = (key) => process.argv[process.argv.indexOf(key) + 1];
const model = JSON.parse(fs.readFileSync(arg('--model')));
const config = JSON.parse(fs.readFileSync(arg('--config')));
if (!arg('--model').endsWith('model.frozen.json') || !arg('--config').endsWith('.frozen.json')) process.exit(4);
const result = {schemaVersion:'1', status:'completed', engineVersion:'test-stub', scenario:'egress',
  metrics:{sensorCount:model.spaces.length, unit:'hour', targetAreaRatio:null,
    totalAgents:(config.agents || []).reduce((n,a)=>n+a.count,0), egressTimeSec:12}, spaces:[],
  verification:{status:'needs_review',checks:[]}};
fs.writeFileSync(path.join(arg('--output'),'result.json'),JSON.stringify(result));
`, { mode: 0o755 });
  config.sunlightPython = stub; config.pedestrianPython = stub;
  const model = optimizationModel();
  const common = { sessionId, revisionId: 'rev-0001', model,
    modelPath: path.join(dir, 'must-not-read-model.json'), configPath: path.join(dir, 'must-not-read-config.json') };
  const sunlight = await runSunlightAnalysis({ ...common, configRaw: optimizationSunlight });
  const pedestrian = await runPedestrianAnalysis({ ...common, configRaw: optimizationPedestrian, strictGeometry: true });
  assert.equal(sunlight.result.metrics.sensorCount, 2);
  assert.equal(pedestrian.result.metrics.totalAgents, 30);
  for (const output of [sunlight, pedestrian]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output.simulationDir, 'model.frozen.json'), 'utf8')), model);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output.simulationDir, 'envelope.json'), 'utf8')).inputHash, output.inputHash);
  }
});
