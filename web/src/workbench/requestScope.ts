/** Tokens include a selection epoch, so returning to the same revision cannot revive old work. */
export function createRequestScope() {
  let context = '', epoch = 0, sequence = 0;
  const channels = new Map<string, number>();
  return {
    setContext(next: string) { if (next !== context) { context = next; epoch++; channels.clear(); } },
    begin(channel: string) {
      const id = ++sequence; channels.set(channel, id);
      return { context, epoch, channel, id };
    },
    isCurrent(token: { context: string; epoch: number; channel: string; id: number }) {
      return token.context === context && token.epoch === epoch && channels.get(token.channel) === token.id;
    },
    invalidate(channel: string) { channels.delete(channel); },
    invalidateAll() { epoch++; channels.clear(); },
  };
}
