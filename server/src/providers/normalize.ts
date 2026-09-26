import type { StreamEvent } from '@sdd/shared';

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * 从多种形态的 content 中提取纯文本：
 * - string
 * - [{type:'text'|'output_text', text}]（Claude / Codex 文本块）
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const r = asRecord(block);
      if (!r) continue;
      const t = str(r.text);
      if (t && (r.type === 'text' || r.type === 'output_text')) parts.push(t);
    }
    return parts.join('');
  }
  return '';
}

export const evText = (text: string): StreamEvent => ({ type: 'text', text });
export const evProgress = (message: string): StreamEvent => ({ type: 'progress', message });
export const evError = (message: string): StreamEvent => ({ type: 'error', message });
export const evThinking = (text: string): StreamEvent => ({ type: 'thinking', text });

/** 从 content 数组中提取 thinking 块（Claude 推理文本） */
export function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const r = asRecord(block);
    if (!r || r.type !== 'thinking') continue;
    const t = str(r.thinking);
    if (t) parts.push(t);
  }
  return parts.join('');
}
