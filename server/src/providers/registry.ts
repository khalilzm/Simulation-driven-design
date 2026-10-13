import type { ProviderId } from '@sdd/shared';
import type { ProviderAdapter } from './types';
import { claudeAdapter } from './claude';
import { cursorAdapter } from './cursor';
import { echoAdapter } from './echo';
import { codexAdapter } from './codex';

const adapters: Record<ProviderId, ProviderAdapter> = {
  cursor: cursorAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
  echo: echoAdapter,
};

export function getAdapter(provider: string): ProviderAdapter {
  const a = adapters[provider as ProviderId];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}

export function isValidProvider(p: unknown): p is ProviderId {
  return p === 'cursor' || p === 'codex' || p === 'claude' || p === 'echo';
}
