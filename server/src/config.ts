import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(moduleDir, '..');
const repoRoot = path.resolve(serverDir, '..');

// 按 config.ts 位置加载 server/.env，不依赖进程 cwd
try {
  process.loadEnvFile(path.join(serverDir, '.env'));
} catch {
  // .env 不存在时使用默认值
}

/** SDK 将空字符串 CURSOR_API_KEY 视为显式无凭证，不会回退到 Cursor.auth.login() 登录态 */
export function sanitizeCursorApiKeyEnv(): void {
  if (!process.env.CURSOR_API_KEY?.trim()) {
    delete process.env.CURSOR_API_KEY;
  }
}

sanitizeCursorApiKeyEnv();

export interface AppConfig {
  port: number;
  host: string;
  claudePath: string;
  model: string;
  cursorApiKey: string;
  cursorModel: string;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 4317),
  host: process.env.HOST ?? '127.0.0.1',
  claudePath: process.env.CLAUDE_PATH ?? 'claude',
  model: process.env.MODEL ?? '',
  cursorApiKey: process.env.CURSOR_API_KEY ?? '',
  cursorModel: process.env.CURSOR_MODEL ?? 'composer-2.5',
};

export const workspacesDir = process.env.WORKSPACES_DIR
  ? path.resolve(process.env.WORKSPACES_DIR)
  : path.join(repoRoot, 'workspaces');
