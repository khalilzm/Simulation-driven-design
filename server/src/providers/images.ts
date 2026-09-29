import fs from 'node:fs';
import path from 'node:path';
import type { ChatTurnInput } from './types';

export function imageAttachments(input: ChatTurnInput): { data: string; mimeType: 'image/png'; dimension: { width: number; height: number } }[] {
  return (input.images ?? []).map((image) => {
    const root = fs.realpathSync(input.cwd);
    const file = fs.realpathSync(path.resolve(root, image.path));
    if (!file.startsWith(root + path.sep)) throw new Error('图片附件必须位于当前会话内');
    const bytes = fs.readFileSync(file);
    if (bytes.length > 15_000_000) throw new Error('图片附件过大');
    return { data: bytes.toString('base64'), mimeType: image.mimeType, dimension: { width: image.width, height: image.height } };
  });
}

export function claudeInput(input: ChatTurnInput): string {
  if (!input.images?.length) return input.message;
  return JSON.stringify({ type: 'user', message: { role: 'user', content: [
    ...imageAttachments(input).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
    { type: 'text', text: input.message },
  ] } }) + '\n';
}
