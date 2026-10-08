import { spawn } from 'node:child_process';

/** Both engines consume snapshots and share bounded, cancellable process execution. */
export function execSimulation(
  python: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  signal?: AbortSignal, timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      cwd, env, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', stopReason: Error | undefined;
    const stop = (reason: Error) => {
      if (stopReason) return;
      stopReason = reason;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may have finished just before cancellation. */ }
    };
    const abort = () => stop(new Error('仿真已取消'));
    const timeout = setTimeout(() => stop(new Error('仿真超时')), timeoutMs);
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-200_000); });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (exitCode) => {
      cleanup();
      if (stopReason) reject(stopReason);
      else if (exitCode !== 0) reject(new Error(stderr.trim() || stdout.trim() || `Python exit ${exitCode}`));
      else resolve({ stdout, stderr, exitCode });
    });
  });
}
