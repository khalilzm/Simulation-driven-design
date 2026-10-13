import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSimulation, SimulationProcessError } from '../src/simulation/process';

test('仿真进程非零退出不会读取为成功；支持取消和超时', async () => {
  await assert.rejects(execSimulation(process.execPath, ['-e', 'process.exit(7)'], process.cwd(), process.env), /exit 7/);
  await assert.rejects(execSimulation(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), process.env,
    AbortSignal.timeout(50)), /取消/);
  await assert.rejects(execSimulation(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), process.env,
    undefined, 50), /超时/);
});


test('non-zero process errors preserve bounded diagnostics and report truncation', async () => {
  await assert.rejects(execSimulation(process.execPath, ['-e', "process.stderr.write('diagnostic');process.stdout.write('x'.repeat(250000),()=>process.exit(9))"], process.cwd(), process.env),
    (error: unknown) => {
      assert.ok(error instanceof SimulationProcessError); assert.equal(error.code, 'process_exit');
      assert.equal(error.output.exitCode, 9); assert.equal(error.output.stdout.length, 200000);
      assert.equal(error.output.stdoutTruncated, true); assert.equal(error.output.stderr, 'diagnostic'); return true;
    });
});

test('pre-cancellation and spawn failures produce structured process errors', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(execSimulation(process.execPath, ['-e', 'process.exit(0)'], process.cwd(), process.env, abort.signal),
    (error: unknown) => error instanceof SimulationProcessError && error.code === 'cancelled' && error.output.exitCode === null);
  await assert.rejects(execSimulation('', [], process.cwd(), process.env),
    (error: unknown) => error instanceof SimulationProcessError && error.code === 'spawn_failed');
  await assert.rejects(execSimulation('/sdd-missing-executable-for-test', [], process.cwd(), process.env),
    (error: unknown) => error instanceof SimulationProcessError && error.code === 'spawn_failed');
});
