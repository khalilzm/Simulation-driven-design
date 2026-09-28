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
  /** 草案未满足的需求、面积偏差或未分配区域 */
  warnings?: string[];
}

export interface ThinkingEvent {
  type: 'thinking';
  text: string;
}

export interface SketchPreviewEvent {
  type: 'sketchPreview';
  /** 相对会话 cwd 的路径，如 inputs/sketch-preview.png */
  path: string;
}

export type StreamEvent =
  | SessionEvent
  | ProgressEvent
  | TextEvent
  | ErrorEvent
  | DoneEvent
  | DesignEvent
  | ThinkingEvent
  | SketchPreviewEvent;
