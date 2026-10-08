import path from 'node:path';
import type { AgentTurnTimings, StreamEvent } from '@sdd/shared';
import {
  Agent,
  configureCursorSdk,
  CursorAgentError,
  JsonlLocalAgentStore,
  type SDKMessage,
} from '@cursor/sdk';
import { config, workspacesDir } from '../config';
import { ensureCursorAuth, explicitCursorApiKey } from './cursorAuth';
import { evError, evProgress, evText } from './normalize';
import type { ChatTurnInput, ProviderAdapter, TurnResult } from './types';
import type { AgentOptions, ToolName } from '@cursor/sdk';
import { imageAttachments } from './images';

const HEARTBEAT_MS = 20_000;
const DEFAULT_MODEL = 'composer-2.5';

/** 空间设计任务：读草图/已有文件 + 写 outline 与 layout */
export const SPACE_DESIGN_ALLOWED_TOOLS: ToolName[] = ['read', 'edit'];

export function buildCursorAgentOptions(
  modelId: string,
  cwd: string,
  apiKey?: string,
  imagePhase?: ChatTurnInput['imagePhase'],
  strategyOnly = false,
): AgentOptions {
  const options: AgentOptions = {
    model: { id: modelId },
    local: { cwd, settingSources: [] },
    tools: strategyOnly ? [] : imagePhase === 'extract' ? ['edit'] : SPACE_DESIGN_ALLOWED_TOOLS,
  };
  if (apiKey) options.apiKey = apiKey;
  return options;
}

let storeReady = false;

function ensureCursorStore(): void {
  if (storeReady) return;
  configureCursorSdk({
    local: { store: new JsonlLocalAgentStore(path.join(workspacesDir, '.cursor-agent-store')) },
  });
  storeReady = true;
}

/** 将系统提示词拼入用户消息，避免替换 Cursor 内置 system prompt */
export function buildCursorPrompt(input: ChatTurnInput): string {
  if (!input.systemPrompt) return input.message;
  return `${input.systemPrompt}\n\n---\n\n${input.message}`;
}

function mapStreamEvent(event: SDKMessage, emit: (e: StreamEvent) => void): void {
  switch (event.type) {
    case 'assistant':
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) emit(evText(block.text));
      }
      break;
    case 'tool_call':
      if (event.status === 'running') emit(evProgress(`调用工具: ${event.name}`));
      break;
    default:
      break;
  }
}

async function disposeAgent(agent: Awaited<ReturnType<typeof Agent.create>>): Promise<void> {
  await agent[Symbol.asyncDispose]();
}

export const cursorAdapter: ProviderAdapter = {
  id: 'cursor',
  async run(input, emit, signal): Promise<TurnResult> {
    const started = performance.now();
    const timings: AgentTurnTimings = { totalMs: 0 };
    const measure = async <T>(key: 'authMs' | 'initializeMs' | 'attachmentsMs' | 'sendMs' | 'runMs' | 'disposeMs', action: () => T | Promise<T>): Promise<T> => {
      const start = performance.now();
      try { return await action(); }
      finally { timings[key] = Math.round((performance.now() - start) * 1000) / 1000; }
    };
    ensureCursorStore();

    const modelId = input.model || config.cursorModel || DEFAULT_MODEL;
    let nativeSessionId: string | undefined;
    let failed = false;

    emit({ type: 'progress', message: '正在启动 Cursor Agent…' });

    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastActivity = Date.now();

    try {
      await measure('authMs', () => ensureCursorAuth(emit));

      const baseOptions = buildCursorAgentOptions(modelId, input.cwd, explicitCursorApiKey(), input.imagePhase, input.strategyOnly);

      agent = await measure('initializeMs', () => input.nativeSessionId
        ? Agent.resume(input.nativeSessionId, baseOptions)
        : Agent.create(baseOptions));

      nativeSessionId = agent.agentId;

      heartbeat = setInterval(() => {
        if (signal?.aborted) return;
        if (Date.now() - lastActivity < HEARTBEAT_MS) return;
        emit({ type: 'progress', message: '模型推理中，请稍候…' });
      }, HEARTBEAT_MS);

      const prompt = buildCursorPrompt(input);
      const images = await measure('attachmentsMs', () => imageAttachments(input));
      const sendStarted = performance.now();
      const activeAgent = agent;
      const run = await measure('sendMs', () => activeAgent.send(images.length ? { text: prompt, images } : prompt));
      let lastToolCompleted: number | undefined;
      let aborting = false;
      let cancelled!: () => void;
      const cancellation = new Promise<null>((resolve) => { cancelled = () => resolve(null); });

      const onAbort = () => {
        aborting = true;
        cancelled();
        if (run.supports('cancel')) void run.cancel().catch(() => {});
        activeAgent.close();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        await measure('runMs', async () => {
          const consume = async () => { for await (const event of run.stream()) {
            if (aborting) break;
            input.onActivity?.();
            lastActivity = Date.now();
            if (timings.firstContentMs === undefined && (event.type === 'assistant' || event.type === 'thinking' || event.type === 'tool_call')) {
              timings.firstContentMs = Math.round((performance.now() - sendStarted) * 1000) / 1000;
            }
            if (event.type === 'tool_call' && event.status === 'completed') lastToolCompleted = performance.now();
            mapStreamEvent(event, emit);
            if (aborting) break;
          } };
          await Promise.race([consume(), cancellation]);
          if (aborting) { failed = true; return; }

          const result = await Promise.race([run.wait(), cancellation]);
          if (!result) { failed = true; return; }
          if (lastToolCompleted !== undefined) timings.afterLastToolMs = Math.round((performance.now() - lastToolCompleted) * 1000) / 1000;
          if (result.status === 'error') {
            emit(evError(result.error?.message || 'Cursor Agent 返回错误'));
            failed = true;
          } else if (result.status === 'cancelled') {
            failed = true;
          }
        });
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      const msg =
        err instanceof CursorAgentError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      emit(evError(msg));
      failed = true;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (agent) {
        const activeAgent = agent;
        try { await measure('disposeMs', async () => {
          if (!signal?.aborted) return disposeAgent(activeAgent);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([disposeAgent(activeAgent), new Promise<void>(resolve => { timer=setTimeout(resolve,3000); })]); }
          finally { clearTimeout(timer); }
        }); }
        catch (error) { emit(evError(error instanceof Error ? error.message : String(error))); failed = true; }
      }
      timings.totalMs = Math.round((performance.now() - started) * 1000) / 1000;
    }

    return { nativeSessionId, failed, timings };
  },
};
