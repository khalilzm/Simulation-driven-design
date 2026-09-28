import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCursorApiKeyEnv } from '../src/config';
import {
  buildCursorAgentOptions,
  buildCursorPrompt,
  SPACE_DESIGN_ALLOWED_TOOLS,
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

test('sanitizeCursorApiKeyEnv 移除空 CURSOR_API_KEY', () => {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = '   ';
  sanitizeCursorApiKeyEnv();
  assert.equal(process.env.CURSOR_API_KEY, undefined);
  if (prev === undefined) delete process.env.CURSOR_API_KEY;
  else process.env.CURSOR_API_KEY = prev;
});
