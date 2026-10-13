import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineTaskEnvelope, SunlightResult } from '@sdd/shared';
import { workspacesDir } from '../src/config';
import { runEngineTask, EngineTaskExecutionError, loadEngineTaskEnvelope, loadCompletedEngineResult } from '../src/analysis/runtime/task';
import { computeEngineInputHash } from '../src/analysis/runtime/inputHash';
import { SimulationProcessError, type SimulationProcessOutput, type execSimulation } from '../src/simulation/process';
import { optimizationModel, optimizationSunlight } from './helpers/optimization';

const captured: SimulationProcessOutput = { stdout: 'engine output', stderr: 'engine diagnostics', exitCode: 0,
  terminationSignal: null, stdoutTruncated: false, stderrTruncated: false };
function setup(t: TestContext) {
  const sessionId = `test-engine-task-${randomUUID()}`;
  t.after(() => fs.rmSync(path.join(workspacesDir, sessionId), { recursive: true, force: true }));
  const input = { sessionId, revisionId: 'rev-0001', capability: 'sunlight' as const,
    moduleId: 'sun-winter', moduleVersion: '2', model: optimizationModel(), config: structuredClone(optimizationSunlight),
    engineVersion: 'test-sun@1', python: process.execPath, script: path.join(workspacesDir, 'test-runner.js'), env: { ...process.env }, timeoutMs: 1000 };
  const result: SunlightResult = { schemaVersion: '1', status: 'completed', engineVersion: input.engineVersion,
    metrics: { unit: 'hour', sensorCount: 1, targetAreaRatio: null }, spaces: [], verification: { status: 'needs_review', checks: [] } };
  const argsOutput = (args: string[]) => args[args.indexOf('--output') + 1];
  const writeResult = (args: string[], value: unknown = result) => fs.writeFileSync(path.join(argsOutput(args), 'result.json'), JSON.stringify(value));
  const execute: typeof execSimulation = async (_, args) => { writeResult(args); return captured; };
  return { input, result, execute, writeResult, argsOutput };
}
function envelope(folder: string): EngineTaskEnvelope { return JSON.parse(fs.readFileSync(path.join(folder, 'envelope.json'), 'utf8')); }
async function rejection(run: Promise<unknown>): Promise<EngineTaskExecutionError> {
  try { await run; assert.fail('task must fail'); }
  catch (error) { assert.ok(error instanceof EngineTaskExecutionError); return error; }
}

test('task snapshots and a running envelope precede execution; completed records preserve module and diagnostics', async t => {
  const s = setup(t);
  const output = await runEngineTask(s.input, async (_, args) => {
    const folder = s.argsOutput(args), running = envelope(folder);
    assert.equal(running.status, 'running'); assert.equal(running.phase, 'executing');
    assert.equal(loadEngineTaskEnvelope(s.input.sessionId, running.taskId).status, 'running');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'model.frozen.json'), 'utf8')), s.input.model);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder, 'sunlight.frozen.json'), 'utf8')), s.input.config);
    s.writeResult(args); return captured;
  });
  const saved = envelope(output.simulationDir);
  assert.equal(saved.schemaVersion, '2'); assert.equal(saved.status, 'completed'); assert.equal(saved.phase, 'finished');
  assert.equal(saved.moduleId, 'sun-winter'); assert.equal(saved.moduleVersion, '2'); assert.ok(saved.finishedAt);
  assert.equal(saved.inputHash, output.inputHash); assert.ok(saved.result?.validated);
  assert.deepEqual(saved.metrics, s.result.metrics); assert.equal(saved.verification && (saved.verification as {status:string}).status, 'needs_review');
  assert.equal(saved.process?.exitCode, 0); assert.ok(saved.artifacts.includes('runner.log'));
  assert.match(fs.readFileSync(path.join(output.simulationDir, 'runner.log'), 'utf8'), /engine output\nengine diagnostics/);
  assert.deepEqual(loadCompletedEngineResult(s.input.sessionId, output.taskId, 'sunlight'), s.result);
});

test('caller mutations cannot change frozen inputs, selected engine, signal or execution-option identity', async t => {
  const s = setup(t), expectedModel = structuredClone(s.input.model), expectedConfig = structuredClone(s.input.config);
  const options = { strictGeometry: true };
  const expectedHash = computeEngineInputHash('sunlight', expectedModel, expectedConfig, s.input.engineVersion, options);
  const output = await runEngineTask({ ...s.input, executionOptions: options }, async (_, args) => {
    s.input.model.floor.height = 99; s.input.config.location.latitude = 88; options.strictGeometry = false;
    s.writeResult(args); return captured;
  });
  assert.equal(output.inputHash, expectedHash);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output.simulationDir, 'model.frozen.json'), 'utf8')), expectedModel);
  assert.deepEqual(envelope(output.simulationDir).executionOptions, { strictGeometry: true });
  assert.notEqual(expectedHash, computeEngineInputHash('sunlight', expectedModel, expectedConfig, s.result.engineVersion, { strictGeometry: false }));
  assert.notEqual(expectedHash, computeEngineInputHash('daylight', expectedModel, expectedConfig, s.result.engineVersion, { strictGeometry: true }));
});

test('missing, malformed and incomplete results remain failed tasks with logs and task references', async t => {
  const s = setup(t);
  const cases: { code: string; produce: (args: string[]) => void }[] = [
    { code: 'missing_result', produce: () => {} },
    { code: 'invalid_json', produce: args => fs.writeFileSync(path.join(s.argsOutput(args), 'result.json'), '{bad') },
    { code: 'invalid_result', produce: args => s.writeResult(args, { ...s.result, engineVersion: 'wrong@1' }) },
    { code: 'invalid_result', produce: args => s.writeResult(args, { ...s.result, metrics: undefined }) },
    { code: 'invalid_result', produce: args => s.writeResult(args, { ...s.result, schemaVersion: 'future' }) },
    { code: 'invalid_result', produce: args => fs.writeFileSync(path.join(s.argsOutput(args), 'result.json'), JSON.stringify(s.result).replace('"sensorCount":1', '"sensorCount":1e309')) },
  ];
  for (const example of cases) {
    const error = await rejection(runEngineTask(s.input, async (_, args) => { example.produce(args); return captured; }));
    assert.equal(error.code, example.code); const saved = envelope(error.simulationDir);
    assert.equal(saved.status, 'failed'); assert.equal(saved.error?.code, example.code); assert.equal(saved.phase, 'finished');
    assert.equal(saved.taskId, error.taskId); assert.ok(!saved.result?.validated);
    assert.ok(fs.readFileSync(path.join(error.simulationDir, 'runner.log'), 'utf8').includes('engine diagnostics'));
  }
});

test('non-zero exit retains structured engine failure and bounded stdout/stderr; it never promotes a result', async t => {
  const s = setup(t);
  const error = await rejection(runEngineTask(s.input, async (_, args) => {
    s.writeResult(args, { schemaVersion: '1', status: 'failed', engineVersion: s.input.engineVersion, error: 'Radiance recipe failed' });
    throw new SimulationProcessError('exit 3', 'process_exit', { ...captured, exitCode: 3, stdoutTruncated: true });
  }));
  assert.equal(error.code, 'engine_failed'); assert.equal(error.message, 'Radiance recipe failed');
  const saved = envelope(error.simulationDir); assert.equal(saved.status, 'failed');
  assert.equal(saved.process?.exitCode, 3); assert.equal(saved.process?.stdoutTruncated, true); assert.equal(saved.result?.validated, false);
  assert.match(fs.readFileSync(path.join(error.simulationDir, 'runner.log'), 'utf8'), /engine output.*\nengine diagnostics.*\nRadiance recipe failed/);
  await assert.rejects(runEngineTask(s.input, async (_, args) => { s.writeResult(args); throw new SimulationProcessError('exit 7', 'process_exit', { ...captured, exitCode: 7 }); }),
    (failure: unknown) => failure instanceof EngineTaskExecutionError && failure.code === 'process_exit');
});

test('pre-cancellation, process cancellation, timeout and spawn errors have distinct durable outcomes', async t => {
  const s = setup(t), abort = new AbortController(); abort.abort(new Error('stop'));
  let executions = 0;
  const stopped = await rejection(runEngineTask({ ...s.input, signal: abort.signal }, async () => { executions++; return captured; }));
  assert.equal(executions, 0); assert.equal(envelope(stopped.simulationDir).status, 'cancelled');
  assert.ok(fs.existsSync(path.join(stopped.simulationDir, 'model.frozen.json')));
  for (const code of ['cancelled', 'timeout', 'spawn_failed'] as const) {
    const error = await rejection(runEngineTask(s.input, async () => { throw new SimulationProcessError(code, code, { ...captured, exitCode: null, terminationSignal: 'SIGKILL' }); }));
    assert.equal(error.code, code); assert.equal(envelope(error.simulationDir).status, code === 'timeout' ? 'timed_out' : code === 'cancelled' ? 'cancelled' : 'failed');
    assert.match(fs.readFileSync(path.join(error.simulationDir, 'runner.log'), 'utf8'), /engine diagnostics/);
  }
});

test('modifying either frozen inputs or completed result artifacts is detected', async t => {
  const s = setup(t);
  const error = await rejection(runEngineTask(s.input, async (_, args) => {
    s.writeResult(args); const model = structuredClone(s.input.model); model.floor.height = 9;
    fs.writeFileSync(args[args.indexOf('--model') + 1], JSON.stringify(model)); return captured;
  }));
  assert.equal(error.code, 'invalid_result');
  const result = await runEngineTask(s.input, s.execute);
  const file = path.join(result.simulationDir, 'result.json'), bytes = fs.readFileSync(file, 'utf8');
  const changed = JSON.parse(bytes); changed.metrics.sensorCount = 2; fs.writeFileSync(file, JSON.stringify(changed));
  assert.throws(() => loadCompletedEngineResult(s.input.sessionId, result.taskId, 'sunlight'), /已变化/);
  fs.writeFileSync(file, bytes);
  const model = structuredClone(s.input.model); model.floor.height = 9;
  fs.writeFileSync(path.join(result.simulationDir, 'model.frozen.json'), JSON.stringify(model));
  assert.throws(() => loadCompletedEngineResult(s.input.sessionId, result.taskId, 'sunlight'), /已变化/);
});

test('orphan running tasks read as interrupted without rewriting historical files', async t => {
  const s = setup(t), result = await runEngineTask(s.input, s.execute), file = path.join(result.simulationDir, 'envelope.json');
  const saved = envelope(result.simulationDir); saved.status = 'running'; saved.phase = 'executing'; delete saved.finishedAt;
  fs.writeFileSync(file, JSON.stringify(saved)); const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(loadEngineTaskEnvelope(s.input.sessionId, result.taskId).status, 'interrupted');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.throws(() => loadCompletedEngineResult(s.input.sessionId, result.taskId, 'sunlight'), /未完成/);
});

test('legacy completed envelopes remain readable and are not migrated by a read', async t => {
  const s = setup(t), result = await runEngineTask(s.input, s.execute), file = path.join(result.simulationDir, 'envelope.json');
  const legacy = { schemaVersion: '1', taskId: result.taskId, sessionId: s.input.sessionId, revisionId: s.input.revisionId,
    tool: 'sunlight.run', inputHash: 'old-hash', engineVersion: s.result.engineVersion, status: 'completed' };
  fs.writeFileSync(file, JSON.stringify(legacy)); const bytes = fs.readFileSync(file, 'utf8');
  assert.deepEqual(loadEngineTaskEnvelope(s.input.sessionId, result.taskId), legacy);
  assert.deepEqual(loadCompletedEngineResult(s.input.sessionId, result.taskId, 'sunlight'), s.result);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
