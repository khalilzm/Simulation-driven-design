import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSimulation } from '../src/simulation/process';

test('仿真进程非零退出不会读取为成功；支持取消和超时', async () => {
  await assert.rejects(execSimulation(process.execPath, ['-e', 'process.exit(7)'], process.cwd(), process.env), /exit 7/);
  await assert.rejects(execSimulation(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), process.env,
    AbortSignal.timeout(50)), /取消/);
  await assert.rejects(execSimulation(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.cwd(), process.env,
    undefined, 50), /超时/);
});
