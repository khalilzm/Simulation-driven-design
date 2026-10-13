import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DAYLIGHT_SETTINGS, type DaylightConfig } from '@sdd/shared';
import { runDaylightAnalysis, DAYLIGHT_ENGINE_ID } from '../src/daylight/run';
import { config, sunlightEngineId, pedestrianEngineId, workspacesDir } from '../src/config';
import { runSunlightAnalysis } from '../src/sunlight/run';
import { runPedestrianAnalysis } from '../src/pedestrian/run';
import { optimizationModel, optimizationSunlight, optimizationPedestrian } from './helpers/optimization';

test('Python 结果生产者与运行器声明相同的引擎协议版本', () => {
  const declarations = [
    ['pedestrian/engine.py', pedestrianEngineId],
    ['sunlight/daylight_engine.py', DAYLIGHT_ENGINE_ID],
    [config.sunlightUseRadiance ? 'sunlight/radiance_engine.py' : 'sunlight/lb_direct_sun.py', sunlightEngineId],
  ];
  for (const [file, expected] of declarations) {
    const source = fs.readFileSync(new URL(`../python/${file}`, import.meta.url), 'utf8');
    assert.equal(source.match(/^ENGINE_ID\s*=\s*["']([^"']+)["']/m)?.[1], expected, file);
  }
});

test('三运行器将模型和工况冻结为独立任务输入（模拟求解器）', async (t) => {
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
const kind = path.basename(arg('--config')).split('.')[0];
const versions = {sunlight:${JSON.stringify(sunlightEngineId)},pedestrian:${JSON.stringify(pedestrianEngineId)},daylight:${JSON.stringify(DAYLIGHT_ENGINE_ID)}};
const envelope = JSON.parse(fs.readFileSync(path.join(arg('--output'),'envelope.json')));
if(envelope.status !== 'running' || envelope.phase !== 'executing') process.exit(5);
let result = {schemaVersion:'1', status:'completed', engineVersion:versions[kind],
  verification:{status:'needs_review',checks:[]}};
if(kind==='sunlight') result={...result,metrics:{sensorCount:model.spaces.length,unit:'hour',targetAreaRatio:null},spaces:[]};
else if(kind==='pedestrian') result={...result,scenario:'egress',metrics:{unit:'second',totalAgents:config.agents.reduce((n,a)=>n+a.count,0),egressTimeSec:12,meanEgressTimeSec:6,peakDoorDensity:[],bottleneckSpaceIds:[]}};
else result={...result,method:'overcast-daylight-factor',outdoorIlluminanceLux:config.outdoorIlluminanceLux,spaces:[],grids:[],assumptions:[]};
fs.writeFileSync(path.join(arg('--output'),'result.json'),JSON.stringify(result));
`, { mode: 0o755 });
  config.sunlightPython = stub; config.pedestrianPython = stub;
  const model = optimizationModel();
  const common = { sessionId, revisionId: 'rev-0001', model };
  const sunlight = await runSunlightAnalysis({ ...common, configRaw: optimizationSunlight });
  const pedestrian = await runPedestrianAnalysis({ ...common, configRaw: optimizationPedestrian, strictGeometry: true });
  assert.equal(sunlight.result.metrics.sensorCount, 2);
  assert.equal(pedestrian.result.metrics.totalAgents, 30);
  const daylightConfig: DaylightConfig = { schemaVersion: '1', ...structuredClone(DEFAULT_DAYLIGHT_SETTINGS), targets: [] };
  const daylight = await runDaylightAnalysis({ ...common, config: daylightConfig });
  for (const output of [sunlight, pedestrian, daylight]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output.simulationDir, 'model.frozen.json'), 'utf8')), model);
    const envelope = JSON.parse(fs.readFileSync(path.join(output.simulationDir, 'envelope.json'), 'utf8'));
    assert.equal(envelope.inputHash, output.inputHash); assert.equal(envelope.schemaVersion, '2');
    assert.equal(envelope.status, 'completed'); assert.equal(envelope.result.validated, true);
    assert.ok(fs.existsSync(path.join(output.simulationDir, 'runner.log')));
  }
});
