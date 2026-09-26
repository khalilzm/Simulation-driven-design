import { spawn } from 'node:child_process';
import type { StreamEvent } from '@sdd/shared';
import type { ChatTurnInput, CommandSpec, ParsedLine, TurnResult } from './types';

/**
 * 启动一个非交互 CLI 进程，消息走 stdin，stdout 逐行解析。
 * shell:false + 参数数组，不拼接用户输入为 shell 命令。
 */
const HEARTBEAT_MS = 20_000;

export function runCliProcess(
  spec: CommandSpec,
  input: ChatTurnInput,
  parseLine: (line: string) => ParsedLine,
  emit: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let nativeSessionId: string | undefined;
    let hadError = false;
    let lastActivity = Date.now();
    emit({ type: 'progress', message: '正在启动 Agent…' });
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity < HEARTBEAT_MS) return;
      emit({ type: 'progress', message: '模型推理中，请稍候…' });
    }, HEARTBEAT_MS);

    const kill = () => {
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }

    child.stdin.on('error', () => {
      // 客户端断开导致 stdin 提前关闭时忽略 EPIPE
    });
    child.stdin.write(input.message);
    child.stdin.end();

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const parsed = parseLine(line);
        if (parsed.nativeSessionId) nativeSessionId = parsed.nativeSessionId;
        if (parsed.event) {
          lastActivity = Date.now();
          if (parsed.event.type === 'error') hadError = true;
          emit(parsed.event);
        }
      }
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', kill);
      reject(err);
    });

    child.on('close', (code) => {
      clearInterval(heartbeat);
      signal?.removeEventListener('abort', kill);
      const failed = hadError || code !== 0;
      if (failed && !hadError && stderr.trim()) {
        emit({ type: 'error', message: stderr.trim().split('\n').slice(-3).join('\n') });
      }
      resolve({ nativeSessionId, failed });
    });
  });
}
