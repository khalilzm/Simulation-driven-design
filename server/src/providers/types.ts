import type { AgentTurnTimings, StreamEvent } from '@sdd/shared';

export interface CommandSpec {
  cmd: string;
  args: string[];
}

export interface ChatTurnInput {
  message: string;
  /** 上一轮 CLI 原生会话 ID（如 Cursor agent id / claude session_id） */
  nativeSessionId?: string;
  /** 会话工作目录 */
  cwd: string;
  model?: string;
  /** 追加到 CLI 的系统提示词（如空间设计约定） */
  systemPrompt?: string;
  /** Native image attachments, relative to cwd. Never rely solely on a path in text. */
  images?: { path: string; mimeType: 'image/png'; width: number; height: number }[];
  /** Initial extraction already has the image and full schema; only write its deliverable. */
  imagePhase?: 'extract' | 'patch';
}

export interface ParsedLine {
  /** 归一化事件，可为 null 表示忽略该行 */
  event: StreamEvent | null;
  nativeSessionId?: string;
}

export interface TurnResult {
  nativeSessionId?: string;
  failed: boolean;
  timings?: AgentTurnTimings;
}

export interface ProviderAdapter {
  readonly id: string;
  run(
    input: ChatTurnInput,
    emit: (e: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TurnResult>;
}
