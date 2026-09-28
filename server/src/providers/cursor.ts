import path from 'node:path';
import type { StreamEvent } from '@sdd/shared';
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

const HEARTBEAT_MS = 20_000;
const DEFAULT_MODEL = 'composer-2.5';

/** 空间设计任务：读草图/已有文件 + 写 outline 与 layout */
export const SPACE_DESIGN_ALLOWED_TOOLS: ToolName[] = ['read', 'edit'];

export function buildCursorAgentOptions(
  modelId: string,
  cwd: string,
  apiKey?: string,
): AgentOptions {
  const options: AgentOptions = {
    model: { id: modelId },
    local: { cwd, settingSources: [] },
    tools: SPACE_DESIGN_ALLOWED_TOOLS,
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
    ensureCursorStore();

    const modelId = input.model || config.cursorModel || DEFAULT_MODEL;
    let nativeSessionId: string | undefined;
    let failed = false;

    emit({ type: 'progress', message: '正在启动 Cursor Agent…' });

    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lastActivity = Date.now();

    try {
      await ensureCursorAuth(emit);

      const baseOptions = buildCursorAgentOptions(modelId, input.cwd, explicitCursorApiKey());

      agent = input.nativeSessionId
        ? await Agent.resume(input.nativeSessionId, baseOptions)
        : await Agent.create(baseOptions);

      nativeSessionId = agent.agentId;

      heartbeat = setInterval(() => {
        if (Date.now() - lastActivity < HEARTBEAT_MS) return;
        emit({ type: 'progress', message: '模型推理中，请稍候…' });
      }, HEARTBEAT_MS);

      const run = await agent.send(buildCursorPrompt(input));
      let aborting = false;

      const onAbort = () => {
        aborting = true;
        if (run.supports('cancel')) void run.cancel();
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        for await (const event of run.stream()) {
          lastActivity = Date.now();
          mapStreamEvent(event, emit);
          if (aborting) break;
        }

        const result = await run.wait();
        if (result.status === 'error') {
          emit(evError(result.error?.message || 'Cursor Agent 返回错误'));
          failed = true;
        } else if (result.status === 'cancelled') {
          failed = true;
        }
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
      if (agent) await disposeAgent(agent);
    }

    return { nativeSessionId, failed };
  },
};
