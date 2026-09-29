import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StreamEvent } from '@sdd/shared';
import type { ChatTurnInput, ProviderAdapter } from '../src/providers/types';
import { runSpaceTurn } from '../src/design/runSpaceTurn';
import { loadOutlineContext, resolveFullCoverage } from '../src/design/outlineContext';
import { buildOutlineJson } from '../src/spacePrompt';
import { validateStoredDesign } from '../src/model/designValidity';
import { layoutModel, rectangle } from './helpers/spaceModel';

function validPlanV2(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    spaces: [{ id: 'training', usage: '训练区', enclosed: false, boundary: rectangle(0, 0, 10, 8).slice(0, -1) }],
    boundaries: [],
    openings: [],
    doors: [],
    windows: [],
    assumptions: [],
    unmetRequirements: [],
    ...overrides,
  };
}

function validIntent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    rooms: [
      { id: 'front', usage: '前台', area: { target: 20 }, privacy: 'public' },
      { id: 'room', usage: '团操室', area: { target: 40 } },
    ],
    adjacencies: [],
    doors: [{ connects: ['front', 'room'], width: 0.9, height: 2.1 }],
    daylight: [],
    assumptions: [],
    unmetRequirements: [],
    ...overrides,
  };
}

function setup(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-space-turn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const model = layoutModel();
  const outline = { source: 'program' as const, outline: buildOutlineJson({ boundary: model.floor.boundary, origin: model.model.origin, bbox: { width: 10, height: 8, area: 80 } }) };
  const folder = path.join(cwd, 'designs', 'rev-0001');
  const events: StreamEvent[] = [], inputs: ChatTurnInput[] = [];
  return { cwd, model, folder, layoutPath: path.join(folder, 'layout.json'), intentPath: path.join(folder, 'intent.json'), modelPath: path.join(folder, 'model.json'), outline, events, inputs };
}

test('新方案写 intent 编译成功，可作为 parent 继续迭代', async (t) => {
  const s = setup(t);
  let calls = 0, folder = s.folder;
  const adapter: ProviderAdapter = { id: 'test', async run() {
    calls++;
    if (calls === 1) {
      fs.writeFileSync(s.intentPath, JSON.stringify(validIntent()));
      return { failed: false };
    }
    fs.writeFileSync(path.join(folder, 'layout.json'), JSON.stringify(validPlanV2()));
    return { failed: false };
  } };
  const first = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {});
  assert.equal(first.failed, false);
  const saved = fs.readFileSync(s.modelPath, 'utf8');
  const parent = JSON.parse(saved);
  folder = path.join(s.cwd, 'designs', 'rev-0002');
  const next = await runSpaceTurn({ cwd: s.cwd, outline: { ...s.outline, source: 'parent', currentModel: parent }, revisionId: 'rev-0002', message: '调整' }, adapter, () => {});
  assert.equal(next.failed, false);
  assert.equal(fs.readFileSync(s.modelPath, 'utf8'), saved);
});

test('无效 intent 触发一次修正', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length === 1) fs.writeFileSync(s.intentPath, JSON.stringify({ schemaVersion: 1, rooms: [], adjacencies: [], daylight: [], assumptions: [], unmetRequirements: [] }));
    else {
      assert.match(input.message, /rooms/);
      fs.writeFileSync(s.intentPath, JSON.stringify(validIntent()));
    }
    return { nativeSessionId: 'native-1', failed: false };
  } };
  const result = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成', requireDesign: true }, adapter, (event) => s.events.push(event));
  assert.equal(result.failed, false);
  assert.equal(s.inputs.length, 2);
  assert.ok(s.events.some((event) => event.type === 'design' && event.valid));
});

test('持续失败最多修正一次，失败稿没有 model.json 且保留诊断', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run() {
    fs.writeFileSync(s.intentPath, JSON.stringify({ schemaVersion: 1, rooms: [], adjacencies: [], daylight: [], assumptions: [], unmetRequirements: [] }));
    return { failed: false };
  } };
  const result = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, (event) => s.events.push(event));
  assert.equal(result.failed, true);
  assert.equal(fs.existsSync(s.modelPath), false);
});

test('对话模式未写 intent 会失败并发出 design.valid=false', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run() { return { failed: false }; } };
  const result = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '你好' }, adapter, (event) => s.events.push(event));
  assert.equal(result.failed, true);
  assert.ok(s.events.some((event) => event.type === 'design' && !event.valid));
  const validation = JSON.parse(fs.readFileSync(path.join(s.folder, 'validation.json'), 'utf8'));
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test('误写到工作区外 designs 时自动复制并继续编译', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-turn-salvage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspaces', 'sess');
  fs.mkdirSync(cwd, { recursive: true });
  const misplaced = path.join(root, 'designs', 'rev-0001', 'intent.json');
  fs.mkdirSync(path.dirname(misplaced), { recursive: true });
  fs.writeFileSync(misplaced, JSON.stringify(validIntent()));
  const model = layoutModel();
  const outline = { source: 'program' as const, outline: buildOutlineJson({ boundary: model.floor.boundary, origin: model.model.origin, bbox: { width: 10, height: 8, area: 80 } }) };
  const adapter: ProviderAdapter = { id: 'test', async run() { return { failed: false }; } };
  const events: StreamEvent[] = [];
  const result = await runSpaceTurn({ cwd, outline, revisionId: 'rev-0001', message: '生成' }, adapter, (event) => events.push(event));
  assert.equal(result.failed, false);
  assert.ok(events.some((event) => event.type === 'design' && event.valid));
  assert.equal(fs.existsSync(path.join(cwd, 'designs', 'rev-0001', 'model.json')), true);
});

test('无效 schemaVersion 被拒绝并提示改用 schemaVersion 1', async (t) => {
  const s = setup(t);
  let attempts = 0;
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    attempts++;
    if (attempts === 1) fs.writeFileSync(s.intentPath, JSON.stringify({ allocations: [{ id: 'x', usage: '区' }] }));
    else {
      assert.match(input.message, /schemaVersion/);
      fs.writeFileSync(s.intentPath, JSON.stringify(validIntent()));
    }
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
  assert.equal(attempts, 2);
});

test('多房间 intent 可编译', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run() {
    fs.writeFileSync(s.intentPath, JSON.stringify(validIntent()));
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
  const model = JSON.parse(fs.readFileSync(s.modelPath, 'utf8'));
  assert.equal(model.spaces.length, 2);
  assert.equal(validateStoredDesign(model).valid, true);
});

test('旧会话直接写几何时隔离文件', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length === 1) fs.writeFileSync(s.modelPath, JSON.stringify(s.model));
    else {
      assert.match(input.message, /不要写 model\.json|只写 intent\.json/);
      fs.writeFileSync(s.intentPath, JSON.stringify(validIntent()));
    }
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
});

test('要求铺满时遗漏面积需修正', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    fs.writeFileSync(s.intentPath, JSON.stringify(validIntent({
      rooms: [{ id: 'part', usage: '部分', area: { target: 20 }, privacy: 'public' }],
    })));
    if (s.inputs.length > 1) {
      fs.writeFileSync(s.intentPath, JSON.stringify(validIntent({
        rooms: [
          { id: 'front', usage: '前台', area: { target: 30 }, privacy: 'public' },
          { id: 'room', usage: '团操室', area: { target: 50 } },
        ],
      })));
    }
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: { ...s.outline, requireFullCoverage: true }, revisionId: 'rev-0001', message: '铺满' }, adapter, () => {})).failed, false);
  assert.equal(s.inputs.length, 2);
});

test('修改方案保留父 model 与固定墙', async (t) => {
  const s = setup(t);
  s.model.walls[0].fixed = true;
  s.model.openings = [{ id: 'entry', hostWallId: 'wall-0', position: 5, width: 1, height: 2.1 }];
  s.model.doors = [{ id: 'door-1', openingId: 'entry', swing: 'none', leafCount: 1, analysisProperties: {} }];
  fs.mkdirSync(s.folder, { recursive: true });
  const parentJson = JSON.stringify(s.model);
  fs.writeFileSync(s.modelPath, parentJson);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    assert.match(input.systemPrompt ?? '', /当前空间/);
    fs.writeFileSync(path.join(s.cwd, 'designs', 'rev-0002', 'layout.json'), JSON.stringify(validPlanV2()));
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: loadOutlineContext(s.cwd, s.model), revisionId: 'rev-0002', message: '调整' }, adapter, () => {})).failed, false);
  assert.equal(fs.readFileSync(s.modelPath, 'utf8'), parentJson);
});

test('铺满要求跨轮次继承', () => {
  assert.equal(resolveFullCoverage('铺满轮廓', true), true);
  assert.equal(resolveFullCoverage('不用铺满', true), false);
});

test('无初始轮廓时 Agent 只写 intent 可编译（外轮廓由程序反推）', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-program-turn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const outlineCtx = { source: 'none' as const };
  const folder = path.join(cwd, 'designs', 'rev-0001');
  const intentPath = path.join(folder, 'intent.json');
  const modelPath = path.join(folder, 'model.json');
  let calls = 0;
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    calls++;
    assert.match(input.systemPrompt ?? '', /intent\.json/);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(intentPath, JSON.stringify(validIntent()));
    return { failed: false };
  } };
  const result = await runSpaceTurn({
    cwd, outline: outlineCtx, revisionId: 'rev-0001', message: '小型培训空间', requireDesign: true,
  }, adapter, () => {});
  assert.equal(result.failed, false);
  assert.equal(calls, 1, '首轮应只调用一次 Agent（只写 intent）');
  assert.equal(fs.existsSync(modelPath), true);
});

test('无初始轮廓时 intent 校验失败会用 intent-only prompt 重试', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-program-turn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const outlineCtx = { source: 'none' as const };
  const folder = path.join(cwd, 'designs', 'rev-0001');
  const intentPath = path.join(folder, 'intent.json');
  const modelPath = path.join(folder, 'model.json');
  let calls = 0;
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    calls++;
    fs.mkdirSync(folder, { recursive: true });
    if (calls === 1) {
      fs.writeFileSync(intentPath, JSON.stringify({ schemaVersion: 1, rooms: [], adjacencies: [], daylight: [], assumptions: [], unmetRequirements: [] }));
    } else {
      fs.writeFileSync(intentPath, JSON.stringify(validIntent()));
    }
    return { failed: false };
  } };
  const result = await runSpaceTurn({
    cwd, outline: outlineCtx, revisionId: 'rev-0001', message: '小型培训空间', requireDesign: true,
  }, adapter, () => {});
  assert.equal(result.failed, false);
  assert.equal(calls, 2, '首轮失败后应重试一次且不抛异常');
  assert.equal(fs.existsSync(modelPath), true);
});
