import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DAYLIGHT_SETTINGS, RESIDENTIAL_SCENARIO, parseScenarioWorkspaceInputs, parseAnalysisPlan, type ScenarioWorkspaceInputs, type AnalysisPlan, type DaylightConfig,
  type DaylightResult, type PedestrianResult, type SunlightResult } from '@sdd/shared';
import { runAnalysisPlan, type AnalysisEngines } from '../src/analysis/runtime/plan';
import { createModelEvaluator } from '../src/optimization/simulate';
import { optimizationAnalysisPlan } from '../src/optimization/analysisPlan';
import { optimizationResultIdentity } from '../src/optimization/resultIdentity';
import { residentialDaylightPlan } from '../src/scenarios/residential/analysisPlan';
import { createScenarioAnalysisPlan } from '../src/scenarios/registry';
import { optimizationModel, optimizationSunlight, optimizationPedestrian, evaluation } from './helpers/optimization';

function setup() {
  const calls: string[] = [];
  const model = optimizationModel();
  const configs = { sunlight: structuredClone(optimizationSunlight), pedestrian: structuredClone(optimizationPedestrian) };
  const daylight: DaylightConfig = { schemaVersion: '1', ...structuredClone(DEFAULT_DAYLIGHT_SETTINGS), targets: [] };
  const sample = evaluation();
  const sun: SunlightResult = { schemaVersion: '1', status: 'completed', engineVersion: sample.sunlight.engineVersion,
    metrics: { unit: 'hour', sensorCount: 50, targetAreaRatio: .5 }, spaces: sample.sunlight.spaces,
    verification: { status: 'needs_review', checks: [] } };
  const ped: PedestrianResult = { schemaVersion: '1', status: 'completed', engineVersion: sample.pedestrian.engineVersion, scenario: 'egress',
    metrics: { unit: 'second', totalAgents: 30, egressTimeSec: 20, meanEgressTimeSec: 10, peakDoorDensity: [], bottleneckSpaceIds: [] },
    verification: { status: 'needs_review', checks: [] } };
  const day: DaylightResult = { schemaVersion: '1', status: 'completed', engineVersion: 'day-v1',
    method: 'overcast-daylight-factor', outdoorIlluminanceLux: 10000, spaces: [], grids: [], assumptions: [] };
  const engines: AnalysisEngines = {
    async sunlight() { calls.push('sunlight'); return { taskId: 'sun', inputHash: 'sun-hash', result: structuredClone(sun), simulationDir: '' }; },
    async pedestrian() { calls.push('pedestrian'); return { taskId: 'ped', inputHash: 'ped-hash', result: structuredClone(ped), simulationDir: '' }; },
    async daylight() { calls.push('daylight'); return { taskId: 'day', inputHash: 'day-hash', result: structuredClone(day), simulationDir: '' }; },
  };
  const context = { sessionId: 'test', revisionId: 'rev-1', model };
  return { calls, model, configs, daylight, sun, ped, engines, context };
}

test('single-capability and empty plans invoke exactly the requested engines', async () => {
  const s = setup();
  for (const step of [{ capability: 'sunlight', config: s.configs.sunlight },
    { capability: 'pedestrian', config: s.configs.pedestrian },
    { capability: 'daylight', config: s.daylight }] as const) {
    const output = await runAnalysisPlan({ ...s.context, plan: { schemaVersion: '1', steps: [step] } }, s.engines);
    assert.deepEqual(Object.keys(output.results), [step.capability]);
  }
  assert.deepEqual(s.calls, ['sunlight', 'pedestrian', 'daylight']);
  const empty = await runAnalysisPlan({ ...s.context, plan: { schemaVersion: '1', steps: [] } }, s.engines);
  assert.deepEqual(empty.results, {}); assert.equal(s.calls.length, 3);
  await runAnalysisPlan({ ...s.context, plan: residentialDaylightPlan(s.daylight) }, s.engines);
  assert.deepEqual(s.calls.slice(3), ['daylight']);
});

test('the entire plan is validated before engine execution, including late invalid references', async () => {
  const s = setup();
  assert.throws(() => parseAnalysisPlan({ schemaVersion: '1', steps: [{ capability: 'thermal', config: {} }] }), /不支持/);
  assert.throws(() => parseAnalysisPlan({ schemaVersion: '1', steps: [
    { capability: 'sunlight', config: s.configs.sunlight }, { capability: 'sunlight', config: s.configs.sunlight }] }), /重复/);
  const plan = optimizationAnalysisPlan(s.configs);
  const second = plan.steps[1]; if (second.capability === 'pedestrian') second.config.agents[0].spaceId = 'missing';
  await assert.rejects(runAnalysisPlan({ ...s.context, plan }, s.engines), /不存在/);
  const bad = structuredClone(s.daylight); bad.sensors.referenceHeightAboveFloor = 3;
  await assert.rejects(runAnalysisPlan({ ...s.context, plan: residentialDaylightPlan(bad) }, s.engines), /层高/);
  assert.deepEqual(s.calls, []);
});

test('ordered steps use the same initial model/config snapshot even if callers or adapters mutate inputs', async () => {
  const s = setup(), plan = optimizationAnalysisPlan(s.configs), expected = structuredClone(plan);
  const originalSun = s.engines.sunlight, originalPed = s.engines.pedestrian;
  s.engines.sunlight = async input => {
    const result = await originalSun(input); input.model.floor.height = 99;
    (input.configRaw as typeof s.configs.sunlight).location.latitude = 88;
    s.model.floor.height = 100;
    const second = plan.steps[1]; if (second.capability === 'pedestrian') second.config.agents[0].count = 999;
    return result;
  };
  s.engines.pedestrian = async input => {
    assert.equal(input.model.floor.height, 3);
    assert.equal((input.configRaw as typeof s.configs.pedestrian).agents[0].count, 10);
    return originalPed(input);
  };
  const output = await runAnalysisPlan({ ...s.context, plan }, s.engines);
  assert.deepEqual(s.calls, ['sunlight', 'pedestrian']); assert.deepEqual(output.plan, expected);
});

test('failure or cancellation stops the plan before its next engine', async () => {
  const s = setup(), plan = optimizationAnalysisPlan(s.configs);
  s.sun.status = 'failed'; s.sun.error = 'engine failure';
  await assert.rejects(runAnalysisPlan({ ...s.context, plan }, s.engines), /engine failure/);
  assert.deepEqual(s.calls, ['sunlight']);
  s.sun.status = 'completed'; s.calls.length = 0;
  const abort = new AbortController(), original = s.engines.sunlight;
  s.engines.sunlight = async input => { const result = await original(input); abort.abort(); return result; };
  await assert.rejects(runAnalysisPlan({ ...s.context, plan, signal: abort.signal }, s.engines));
  assert.deepEqual(s.calls, ['sunlight']);
  s.calls.length = 0;
  await assert.rejects(runAnalysisPlan({ ...s.context, plan, signal: abort.signal }, s.engines));
  assert.deepEqual(s.calls, []);
});

test('existing optimization summaries stay compatible; unsupported policy plans fail before physics', async () => {
  const s = setup(), evaluate = createModelEvaluator(s.engines);
  const run = { sessionId: 'test', baseRevisionId: 'rev-1', scenarioHash: 'scenario', configs: s.configs };
  const result = await evaluate(s.model, run, new AbortController().signal, () => {});
  const expected=evaluation();expected.sunlight.allocations=undefined;
  expected.identity=optimizationResultIdentity(s.model,run);
  assert.deepEqual(result, expected); assert.deepEqual(s.calls, ['sunlight', 'pedestrian']);
  s.calls.length = 0;
  const onlyPed: AnalysisPlan = { schemaVersion: '1', steps: [{ capability: 'pedestrian', config: s.configs.pedestrian }] };
  await assert.rejects(evaluate(s.model, { ...run, analysisPlan: onlyPed }, new AbortController().signal, () => {}), /比较策略/);
  assert.deepEqual(s.calls, []);
  s.sun.spaces[0].sensorCount = 0;
  await assert.rejects(evaluate(s.model, run, new AbortController().signal, () => {}), /测点不完整/);
  assert.deepEqual(s.calls, ['sunlight']);
});

test('residential defaults do not restrict explicit modules; repeated capabilities keep separate results',async()=>{
  const s=setup();
  const workspace:ScenarioWorkspaceInputs={schemaVersion:'1',scenario:{id:'residential',version:'1'},
    baseMap:{kind:'dxf',id:'base',version:'1'},spaceGraph:{id:'graph',version:'3'},simulationModules:[
      {moduleId:'summer-sun',version:'1',capability:'sunlight',config:s.configs.sunlight},
      {moduleId:'egress-standard',version:'1',capability:'pedestrian',config:s.configs.pedestrian},
      {moduleId:'egress-short',version:'2',capability:'pedestrian',config:{...s.configs.pedestrian,maxDurationSec:60}},
    ]};
  assert.deepEqual(RESIDENTIAL_SCENARIO.defaultAnalysisIds,['daylight']);
  const plan=createScenarioAnalysisPlan(workspace);
  assert.deepEqual(plan.steps.map(step=>step.capability),['sunlight','pedestrian','pedestrian']);
  const original=s.engines.pedestrian;
  s.engines.pedestrian=async input=>{
    const out=await original(input),duration=(input.configRaw as typeof s.configs.pedestrian).maxDurationSec;
    return {...out,taskId:`ped-${duration}`,result:{...out.result,metrics:{...out.result.metrics,egressTimeSec:duration}}};
  };
  const output=await runAnalysisPlan({...s.context,plan},s.engines);
  assert.deepEqual(s.calls,['sunlight','pedestrian','pedestrian']);
  assert.deepEqual(Object.keys(output.moduleResults),['summer-sun','egress-standard','egress-short']);
  assert.equal(output.moduleResults['egress-standard'].taskId,'ped-120');
  assert.equal(output.moduleResults['egress-short'].taskId,'ped-60');
  // Ambiguous same-capability summaries must not silently pick the last condition.
  assert.equal(output.results.pedestrian,undefined);assert.equal(output.results.daylight,undefined);
  assert.ok(output.results.sunlight);
});

test('workspace input references and module identity are validated independently of building use',()=>{
  const s=setup();
  const workspace:ScenarioWorkspaceInputs={schemaVersion:'1',scenario:{id:'residential',version:'1'},
    baseMap:{kind:'map',id:'map-resource',version:'2'},spaceGraph:{id:'graph',version:'3'},simulationModules:[
      {moduleId:'indoor-light',version:'1',capability:'daylight',config:s.daylight},
    ]};
  assert.equal(parseScenarioWorkspaceInputs(workspace).baseMap.kind,'map');
  assert.equal(createScenarioAnalysisPlan(workspace).steps.length,1);
  assert.throws(()=>parseScenarioWorkspaceInputs({...workspace,spaceGraph:{id:'graph',version:''}}),/空间节点/);
  assert.throws(()=>parseScenarioWorkspaceInputs({...workspace,simulationModules:[...workspace.simulationModules,...workspace.simulationModules]}),/重复/);
  assert.throws(()=>createScenarioAnalysisPlan({...workspace,scenario:{id:'residential',version:'999'}}),/版本/);
});


test('module identity and version reach the engine task adapter without changing execution selection', async () => {
  const s = setup(), original = s.engines.daylight;
  s.engines.daylight = async input => {
    assert.equal(input.moduleId, 'daylight-cloudy'); assert.equal(input.moduleVersion, '3'); return original(input);
  };
  const output = await runAnalysisPlan({ ...s.context, plan: { schemaVersion: '1', steps: [
    { capability: 'daylight', config: s.daylight, moduleId: 'daylight-cloudy', moduleVersion: '3' },
  ] } }, s.engines);
  assert.deepEqual(s.calls, ['daylight']); assert.equal(output.moduleResults['daylight-cloudy'].taskId, 'day');
});
