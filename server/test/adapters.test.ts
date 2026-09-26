import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StreamEvent } from '@sdd/shared';
import { buildCommand as claudeCmd, parseLine as claudeParse } from '../src/providers/claude';
import { echoAdapter } from '../src/providers/echo';

test('claude 首轮命令构造', () => {
  const c = claudeCmd({ message: 'hi', cwd: '/tmp' });
  assert.equal(c.cmd, 'claude');
  assert.deepEqual(c.args, ['-p', '--output-format', 'stream-json', '--verbose', '--bare', '--tools', 'Write', '--disable-slash-commands', '--effort', 'low', '--permission-mode', 'acceptEdits']);
});

test('claude 续跑命令构造', () => {
  const c = claudeCmd({ message: 'hi', cwd: '/tmp', nativeSessionId: 'sess-9' });
  assert.deepEqual(c.args, ['-p', '--output-format', 'stream-json', '--verbose', '--bare', '--tools', 'Write', '--disable-slash-commands', '--effort', 'low', '--permission-mode', 'acceptEdits', '--resume', 'sess-9']);
});

test('claude 带系统提示词', () => {
  const c = claudeCmd({ message: 'hi', cwd: '/tmp', systemPrompt: '你是空间设计 Agent' });
  assert.deepEqual(c.args, ['-p', '--output-format', 'stream-json', '--verbose', '--bare', '--tools', 'Write', '--disable-slash-commands', '--effort', 'low', '--permission-mode', 'acceptEdits', '--append-system-prompt', '你是空间设计 Agent']);
});

test('claude 事件归一化', () => {
  const init = claudeParse(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
  assert.equal(init.nativeSessionId, 'sess-1');

  const text = claudeParse(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '方案如下' }] } }),
  );
  assert.equal(text.event?.type, 'text');
  assert.equal((text.event as { text: string }).text, '方案如下');

  const err = claudeParse(JSON.stringify({ type: 'result', is_error: true, session_id: 'sess-1' }));
  assert.equal(err.event?.type, 'error');

  const thinking = claudeParse(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '推理中' }] } }),
  );
  assert.equal(thinking.event, null);
});

test('echo 适配器回显', async () => {
  const events: StreamEvent[] = [];
  const result = await echoAdapter.run(
    { message: '测试', cwd: '/tmp' },
    (e) => events.push(e),
  );
  assert.equal(result.failed, false);
  assert.ok(events.some((e) => e.type === 'text' && (e as { text: string }).text.includes('测试')));
});
