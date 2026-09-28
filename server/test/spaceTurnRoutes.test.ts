import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { StreamEvent } from '@sdd/shared';
import { handleSpaceTurn } from '../src/routes/spaceTurn';
import { echoAdapter } from '../src/providers/echo';
import type { ChatTurnInput } from '../src/providers/types';
import { workspacesDir } from '../src/config';
import { loadSession } from '../src/sessions/store';
import { listDesigns } from '../src/model/store';
import { layoutModel } from './helpers/spaceModel';
import { v2Layout } from './helpers/v2Layout';

async function request(body: unknown, generate: boolean) {
  const req = Object.assign(new EventEmitter(), { body }) as Request;
  const events: StreamEvent[] = [];
  let statusCode = 200;
  let responseBody: unknown;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false,
    setHeader() {}, flushHeaders() {},
    status(code: number) { statusCode = code; return this; },
    json(value: unknown) { responseBody = value; return this; },
    write(chunk: string) { events.push(JSON.parse(chunk)); return true; },
    end() { this.writableEnded = true; return this; },
  }) as unknown as Response;
  await handleSpaceTurn(req, res, generate);
  return { statusCode, responseBody, events };
}

function workspace(t: TestContext) {
  const sessionId = `test-layout-${randomUUID()}`;
  const cwd = path.join(workspacesDir, sessionId);
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { sessionId, cwd };
}

test('两个入口共用服务端轮廓及修正流程，生成按钮保存可续跑会话', async (t) => {
  const inputs: ChatTurnInput[] = [];
  t.mock.method(echoAdapter, 'run', async (input: ChatTurnInput) => {
    inputs.push(input);
    fs.writeFileSync(path.join(input.cwd, 'designs', 'rev-0001', 'intent.json'), JSON.stringify({
      schemaVersion: 1,
      rooms: [{ id: 'training', usage: '训练区', area: { target: 60 }, privacy: 'public' }],
      adjacencies: [],
      daylight: [],
      assumptions: [],
      unmetRequirements: [],
    }));
    return { nativeSessionId: 'native-route', failed: false };
  });
  const prompts: string[] = [];
  for (const generate of [false, true]) {
    const { sessionId, cwd } = workspace(t);
    const inputsDir = path.join(cwd, 'inputs');
    fs.mkdirSync(inputsDir, { recursive: true });
    const model = layoutModel();
    fs.writeFileSync(path.join(inputsDir, 'outline.json'), JSON.stringify({
      boundary: model.floor.boundary.slice(0, -1),
      origin: model.model.origin,
      units: 'm',
      assumptions: ['测试轮廓'],
    }));
    const response = await request({ sessionId, provider: 'echo', message: '生成健身房' }, generate);
    assert.equal(response.statusCode, 200);
    assert.ok(response.events.some((event) => event.type === 'design' && event.valid));
    assert.equal(response.events.at(-1)?.type, 'done');
    assert.equal(loadSession(sessionId)?.nativeSessionId, 'native-route');
    prompts.push(inputs.at(-1)!.systemPrompt!);
  }
  assert.equal(prompts[0], prompts[1]);
  assert.ok(prompts[0].includes('rooms'));
});

test('生成入口接受已有方案，并按显式选中的父版本修改', async (t) => {
  const { sessionId, cwd } = workspace(t);
  const model = layoutModel();
  for (const revisionId of ['rev-0001', 'rev-0002']) {
    const folder = path.join(cwd, 'designs', revisionId);
    fs.mkdirSync(folder, { recursive: true });
    const saved = structuredClone(model);
    saved.model.revisionId = revisionId;
    saved.spaces[0].usage = revisionId === 'rev-0001' ? '有氧训练区' : '力量训练区';
    fs.writeFileSync(path.join(folder, 'model.json'), JSON.stringify(saved));
  }
  t.mock.method(echoAdapter, 'run', async (input: ChatTurnInput) => {
    assert.match(input.systemPrompt ?? '', /有氧训练区/);
    assert.doesNotMatch(input.systemPrompt ?? '', /力量训练区/);
    fs.writeFileSync(path.join(cwd, 'designs', 'rev-0003', 'layout.json'), JSON.stringify(v2Layout({ spaces: [{ id: 'training', usage: '有氧训练区', enclosed: false, boundary: [[0, 0], [10, 0], [10, 8], [0, 8]] }] })));
    return { failed: false };
  });
  const response = await request({ sessionId, provider: 'echo', parentRevisionId: 'rev-0001' }, true);
  assert.equal(response.statusCode, 200);
  assert.ok(response.events.some((event) => event.type === 'design' && event.valid));
  const child = JSON.parse(fs.readFileSync(path.join(cwd, 'designs', 'rev-0003', 'model.json'), 'utf8'));
  assert.equal(child.model.parentRevisionId, 'rev-0001');
});

test('生成入口无上传轮廓时会调用 Agent；仅 layout 无 outline 时 done 为 failed', async (t) => {
  const { sessionId, cwd } = workspace(t);
  let calls = 0;
  const captured: ChatTurnInput[] = [];
  t.mock.method(echoAdapter, 'run', async (input: ChatTurnInput) => {
    calls++;
    captured.push(input);
    fs.writeFileSync(path.join(input.cwd, 'designs', 'rev-0001', 'layout.json'), JSON.stringify({ schemaVersion: 2, spaces: [], assumptions: [], unmetRequirements: [] }));
    return { failed: false };
  });
  const missing = await request({ sessionId, provider: 'echo' }, true);
  assert.equal(missing.statusCode, 200);
  assert.equal(calls, 1);
  assert.match(captured[0].systemPrompt ?? '', /inputs\/outline\.json/);
  assert.deepEqual(missing.events.at(-1), { type: 'done', status: 'failed' });
  const folder = path.join(cwd, 'designs', 'rev-0001');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'model.json'), JSON.stringify(layoutModel()));
  fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: true, status: 'accepted' }));
  const failed = await request({ sessionId, provider: 'echo' }, true);
  assert.ok(calls >= 2);
  assert.deepEqual(failed.events.at(-1), { type: 'done', status: 'failed' });
  assert.deepEqual(listDesigns(sessionId).filter((design) => design.valid).map((design) => design.revisionId), ['rev-0001']);
});

test('默认继承最后的有效方案，拒绝显式选择旧越界稿或 pending 版本', async (t) => {
  const { sessionId, cwd } = workspace(t);
  for (const revisionId of ['rev-0001', 'rev-0002', 'rev-0003']) {
    const model = layoutModel();
    model.model.revisionId = revisionId;
    model.spaces[0].usage = revisionId === 'rev-0001' ? '有效有氧区' : '无效力量区';
    if (revisionId === 'rev-0002') model.spaces[0].boundary = [[0, 0], [20, 0], [20, 8], [0, 8], [0, 0]];
    const folder = path.join(cwd, 'designs', revisionId);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'model.json'), JSON.stringify(model));
    if (revisionId === 'rev-0003') fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: false, status: 'pending' }));
  }
  let calls = 0;
  t.mock.method(echoAdapter, 'run', async (input: ChatTurnInput) => {
    calls++;
    assert.match(input.systemPrompt ?? '', /有效有氧区/);
    assert.doesNotMatch(input.systemPrompt ?? '', /无效力量区/);
    fs.writeFileSync(path.join(cwd, 'designs', 'rev-0004', 'layout.json'), JSON.stringify(v2Layout()));
    return { failed: false };
  });
  assert.equal((await request({ sessionId, provider: 'echo', parentRevisionId: 'rev-0002' }, true)).statusCode, 409);
  assert.equal((await request({ sessionId, provider: 'echo', parentRevisionId: 'rev-0003' }, true)).statusCode, 409);
  assert.equal(calls, 0);
  const response = await request({ sessionId, provider: 'echo' }, true);
  assert.ok(response.events.some((event) => event.type === 'design' && event.valid));
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, 'designs', 'rev-0004', 'model.json'), 'utf8'));
  assert.equal(saved.model.parentRevisionId, 'rev-0001');
});
