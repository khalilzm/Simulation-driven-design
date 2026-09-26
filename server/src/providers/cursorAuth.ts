import type { StreamEvent } from '@sdd/shared';
import { Cursor } from '@cursor/sdk';
import { config } from '../config';
import { evProgress, evText } from './normalize';

/** 显式配置的 API Key；未配置时走 Cursor 账号登录态 */
export function explicitCursorApiKey(): string | undefined {
  const key = config.cursorApiKey || process.env.CURSOR_API_KEY;
  return key?.trim() ? key : undefined;
}

/** 确保可用凭证：优先 env，否则使用 ~/.cursor/sdk/auth.json 中的账号登录态 */
export async function ensureCursorAuth(emit: (e: StreamEvent) => void): Promise<void> {
  if (explicitCursorApiKey()) return;

  const status = await Cursor.auth.status();
  if (status.status === 'logged-in') return;

  emit(evProgress('请在浏览器中登录 Cursor 账号（与 IDE 相同账号）…'));
  await Cursor.auth.login({
    onLoginUrl: (url) => {
      emit(evText(`若浏览器未自动打开，请访问登录链接：\n${url}\n`));
    },
  });
}
