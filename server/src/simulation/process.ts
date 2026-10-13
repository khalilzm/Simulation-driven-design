import { spawn } from 'node:child_process';

export interface SimulationProcessOutput {
  stdout: string; stderr: string; exitCode: number | null; terminationSignal: NodeJS.Signals | null;
  stdoutTruncated: boolean; stderrTruncated: boolean;
}
export type SimulationProcessErrorCode = 'cancelled' | 'timeout' | 'spawn_failed' | 'process_exit';
export class SimulationProcessError extends Error {
  constructor(message: string, public readonly code: SimulationProcessErrorCode,
    public readonly output: SimulationProcessOutput, options?: ErrorOptions) {
    super(message, options); this.name = 'SimulationProcessError';
  }
}

/** All engines share bounded diagnostic capture and cancellable process-group execution. */
export function execSimulation(python: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  signal?: AbortSignal, timeoutMs = 180_000): Promise<SimulationProcessOutput> {
  const emptyOutput: SimulationProcessOutput = { stdout: '', stderr: '', exitCode: null, terminationSignal: null, stdoutTruncated: false, stderrTruncated: false };
  if (signal?.aborted) return Promise.reject(new SimulationProcessError('仿真已取消', 'cancelled', emptyOutput, { cause: signal.reason }));
  return new Promise((resolve, reject) => {
    const start = () => spawn(python, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      cwd, env, detached: process.platform !== 'win32' });
    let child: ReturnType<typeof start>;
    try { child = start(); }
    catch (error) { reject(new SimulationProcessError(error instanceof Error ? error.message : String(error), 'spawn_failed', emptyOutput, { cause: error })); return; }
    let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false, settled = false;
    let stopReason: { code: SimulationProcessErrorCode; message: string } | undefined;
    const output = (exitCode: number | null, terminationSignal: NodeJS.Signals | null): SimulationProcessOutput =>
      ({ stdout, stderr, exitCode, terminationSignal, stdoutTruncated, stderrTruncated });
    const stop = (code: SimulationProcessErrorCode, message: string) => {
      if (stopReason || settled) return;
      stopReason = { code, message };
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may have finished just before cancellation. */ }
    };
    const abort = () => stop('cancelled', '仿真已取消');
    const timeout = setTimeout(() => stop('timeout', '仿真超时'), timeoutMs);
    const cleanup = () => { settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; stdoutTruncated ||= stdout.length > 200_000; stdout = stdout.slice(-200_000); });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; stderrTruncated ||= stderr.length > 200_000; stderr = stderr.slice(-200_000); });
    child.on('error', error => {
      if (settled) return;
      cleanup(); reject(new SimulationProcessError(stopReason?.message ?? error.message,
        stopReason?.code ?? 'spawn_failed', output(null, null), { cause: error }));
    });
    child.on('close', (exitCode, terminationSignal) => {
      if (settled) return;
      cleanup(); const captured = output(exitCode, terminationSignal);
      if (stopReason) reject(new SimulationProcessError(stopReason.message, stopReason.code, captured));
      else if (exitCode !== 0) reject(new SimulationProcessError(stderr.trim() || stdout.trim() || `Python exit ${exitCode}`, 'process_exit', captured));
      else resolve(captured);
    });
  });
}
