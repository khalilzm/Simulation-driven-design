import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '@cursor/sdk';
import { sanitizeCursorApiKeyEnv } from '../src/config';
import {
  buildCursorAgentOptions,
  buildCursorPrompt,
  SPACE_DESIGN_ALLOWED_TOOLS,
  cursorAdapter,
} from '../src/providers/cursor';
import { explicitCursorApiKey } from '../src/providers/cursorAuth';
import { isValidProvider } from '../src/providers/registry';

test('isValidProvider 包含 cursor', () => {
  assert.equal(isValidProvider('cursor'), true);
});

test('buildCursorPrompt 拼接系统提示词', () => {
  const prompt = buildCursorPrompt({
    message: '设计户型',
    cwd: '/tmp',
    systemPrompt: '你是空间设计 Agent',
  });
  assert.match(prompt, /你是空间设计 Agent/);
  assert.match(prompt, /设计户型/);
});

test('buildCursorPrompt 无系统提示词时原样返回', () => {
  const prompt = buildCursorPrompt({ message: '你好', cwd: '/tmp' });
  assert.equal(prompt, '你好');
});

test('explicitCursorApiKey 空字符串视为未配置', () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = '   ';
  assert.equal(explicitCursorApiKey(), undefined);
  process.env.CURSOR_API_KEY = prev;
});

test('SPACE_DESIGN_ALLOWED_TOOLS 允许 read 与 edit', () => {
  assert.deepEqual(SPACE_DESIGN_ALLOWED_TOOLS, ['read', 'edit']);
});

test('buildCursorAgentOptions 限制工具并传入 cwd', () => {
  const options = buildCursorAgentOptions('composer-2.5', '/tmp/ws', 'key-123');
  assert.deepEqual(options.tools, ['read', 'edit']);
  assert.equal(options.local?.cwd, '/tmp/ws');
  assert.equal(options.apiKey, 'key-123');
});

test('原生图片首次识别只开放写入，修正允许读取已知产物', () => {
  assert.deepEqual(buildCursorAgentOptions('composer-2.5', '/tmp/ws', undefined, 'extract').tools, ['edit']);
  assert.deepEqual(buildCursorAgentOptions('composer-2.5', '/tmp/ws', undefined, 'patch').tools, ['read', 'edit']);
});

test('sanitizeCursorApiKeyEnv 移除空 CURSOR_API_KEY', () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = '   ';
  sanitizeCursorApiKeyEnv();
  assert.equal(process.env.CURSOR_API_KEY, undefined);
  if (prev === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = prev;
});

test('Cursor 记录启动、运行、工具后等待和清理耗时，不调用真实模型', async (t) => {
  const previousKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'test-only';
  t.after(() => { if (previousKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousKey; });
  let disposed = false;
  const fakeAgent = {
    agentId: 'timing-test-agent',
    async send() {
      return {
        async *stream() {
          yield { type: 'tool_call', name: 'edit', status: 'completed' };
          yield { type: 'assistant', message: { content: [{ type: 'text', text: '已保存' }] } };
        },
        async wait() { return { status: 'finished' }; },
      };
    },
    async [Symbol.asyncDispose]() { disposed = true; },
  } as unknown as Awaited<ReturnType<typeof Agent.create>>;
  t.mock.method(Agent, 'create', async () => fakeAgent);
  const result = await cursorAdapter.run({ cwd: '/tmp', message: '识别' }, () => {});
  assert.equal(result.failed, false);
  assert.equal(disposed, true);
  for (const key of ['authMs', 'initializeMs', 'attachmentsMs', 'sendMs', 'runMs', 'disposeMs', 'firstContentMs', 'afterLastToolMs'] as const) {
    assert.ok(Number.isFinite(result.timings![key]));
    assert.ok(result.timings![key]! >= 0);
  }
  assert.ok(result.timings!.totalMs > 0);
});

test('Cursor 初始化失败也返回阶段耗时', async (t) => {
  const previousKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'test-only';
  t.after(() => { if (previousKey === undefined) delete process.env.CURSOR_API_KEY; else process.env.CURSOR_API_KEY = previousKey; });
  t.mock.method(Agent, 'create', async () => { throw new Error('初始化失败'); });
  const result = await cursorAdapter.run({ cwd: '/tmp', message: '识别' }, () => {});
  assert.equal(result.failed, true);
  assert.ok(result.timings!.initializeMs! >= 0);
  assert.equal(result.timings!.runMs, undefined);
});

test('Cursor 流不再产生事件时取消仍能退出，不等待下一个流事件',async t=> {
  const previousKey=process.env.CURSOR_API_KEY;process.env.CURSOR_API_KEY='test-only';
  t.after(()=>{if(previousKey===undefined)delete process.env.CURSOR_API_KEY;else process.env.CURSOR_API_KEY=previousKey;});
  let closed=false,cancelled=false;
  const controller=new AbortController();
  const fakeAgent={agentId:'cancel-test-agent',close(){closed=true;},async send(){return {
    supports(){return true;},async cancel(){cancelled=true;},
    async *stream(){controller.abort(new Error('用户取消'));await new Promise(()=>{});},
    async wait(){return {status:'finished'};},
  };},async [Symbol.asyncDispose](){}} as unknown as Awaited<ReturnType<typeof Agent.create>>;
  t.mock.method(Agent,'create',async()=>fakeAgent);
  const result=await cursorAdapter.run({cwd:'/tmp',message:'json',strategyOnly:true},()=>{},controller.signal);
  assert.equal(result.failed,true);assert.equal(closed,true);assert.equal(cancelled,true);
});
