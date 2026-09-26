// NDJSON 统一事件信封（对齐 docs/protocol.md §对话请求）

export type DoneStatus = 'completed' | 'failed';

export interface SessionEvent {
  type: 'session';
  sessionId: string;
  provider: string;
}

export interface ProgressEvent {
  type: 'progress';
  message: string;
}

export interface TextEvent {
  type: 'text';
  text: string;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
}

export interface DoneEvent {
  type: 'done';
  status: DoneStatus;
}

export interface DesignEvent {
  type: 'design';
  revisionId: string;
  valid: boolean;
  errors: string[];
  /** 后处理自动修复说明（如裁切越界房间） */
  warnings?: string[];
}

export interface ThinkingEvent {
  type: 'thinking';
  text: string;
}

export type StreamEvent =
  | SessionEvent
  | ProgressEvent
  | TextEvent
  | ErrorEvent
  | DoneEvent
  | DesignEvent
  | ThinkingEvent;
