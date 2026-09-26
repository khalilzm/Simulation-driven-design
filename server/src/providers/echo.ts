import type { ProviderAdapter, TurnResult } from './types';

export const echoAdapter: ProviderAdapter = {
  id: 'echo',
  async run(input, emit): Promise<TurnResult> {
    emit({ type: 'progress', message: 'echo 提供方：不调用模型，直接回显' });
    emit({ type: 'text', text: `echo: ${input.message}` });
    return { failed: false };
  },
};
