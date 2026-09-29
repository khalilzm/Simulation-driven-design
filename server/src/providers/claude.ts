import { config } from '../config';
import { asRecord, evError, evProgress, evText, extractText, extractThinking, parseJsonLine, str } from './normalize';
import { runCliProcess } from './spawn';
import type { ChatTurnInput, CommandSpec, ParsedLine, ProviderAdapter } from './types';
import { claudeInput } from './images';

export function buildCommand(input: ChatTurnInput): CommandSpec {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--bare',
    '--tools',
    input.imagePhase === 'extract' ? 'Write' : 'Read,Write',
    '--disable-slash-commands',
    '--effort',
    'low',
    '--permission-mode',
    'acceptEdits',
  ];
  if (input.images?.length) args.push('--input-format', 'stream-json');
  if (input.systemPrompt) args.push('--append-system-prompt', input.systemPrompt);
  if (input.nativeSessionId) args.push('--resume', input.nativeSessionId);
  if (input.model) args.push('--model', input.model);
  return { cmd: config.claudePath, args };
}

function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((b) => asRecord(b)?.type === 'tool_use');
}

export function parseLine(line: string): ParsedLine {
  const obj = parseJsonLine(line);
  if (!obj) return { event: null };
  const type = str(obj.type);
  switch (type) {
    case 'system':
      return { event: null, nativeSessionId: str(obj.session_id) };
    case 'assistant': {
      const content = asRecord(obj.message)?.content;
      const t = extractText(content);
      if (t) return { event: evText(t) };
      // 协议约定不转发 thinking，避免前端长时间停留在“思考中”
      if (extractThinking(content)) return { event: null };
      if (hasToolUse(content)) return { event: evProgress('调用工具') };
      return { event: null };
    }
    case 'tool_use':
      return { event: evProgress('调用工具') };
    case 'result': {
      const isErr = obj.is_error === true;
      const sid = str(obj.session_id);
      if (isErr) return { event: evError('Claude 返回错误'), nativeSessionId: sid };
      return { event: null, nativeSessionId: sid };
    }
    default:
      return { event: null };
  }
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  run(input, emit, signal) {
    return runCliProcess(buildCommand(input), { ...input, message: claudeInput(input) }, parseLine, emit, signal);
  },
};
