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
import { layoutModel } from './helpers/spaceModel';

function validPlan(regionIds = ['r1']) {
  return { allocations: [{ id: 'training', usage: '训练区', regionIds, enclosed: false }] };
}
function setup(t: TestContext) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-space-turn-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const model = layoutModel();
  const outline = { source: 'dxf' as const, outline: buildOutlineJson({ boundary: model.floor.boundary, origin: model.model.origin, bbox: { width: 10, height: 8, area: 80 } }) };
  const folder = path.join(cwd, 'designs', 'rev-0001');
  const events: StreamEvent[] = [], inputs: ChatTurnInput[] = [];
  return { cwd, model, folder, layoutPath: path.join(folder, 'layout.json'), modelPath: path.join(folder, 'model.json'), outline, events, inputs };
}

test('区域错误触发一次修正，实际分配内容随反馈发送，几何由服务端生成', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length > 1) {
      assert.match(input.message, /outside 不存在/);
      assert.match(input.message, /当前文件内容/);
      assert.equal(input.nativeSessionId, 'native-1');
    }
    fs.writeFileSync(s.layoutPath, JSON.stringify(validPlan(s.inputs.length === 1 ? ['outside'] : ['r1'])));
    return { nativeSessionId: 'native-1', failed: false };
  } };
  const result = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成健身房', requireDesign: true }, adapter, (event) => s.events.push(event));
  assert.equal(result.failed, false);
  assert.equal(s.inputs.length, 2);
  assert.ok(s.events.some((event) => event.type === 'design' && event.valid));
  const model = JSON.parse(fs.readFileSync(s.modelPath, 'utf8'));
  assert.deepEqual(model.floor.boundary, s.model.floor.boundary);
  assert.deepEqual(model.model.origin, s.model.model.origin);
  assert.equal(model.walls.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.folder, 'validation.json'), 'utf8')).valid, true);
});

test('持续失败最多修正一次，失败稿没有 model.json 且保留诊断', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    fs.writeFileSync(s.layoutPath, JSON.stringify(validPlan(['outside'])));
    return { failed: false };
  } };
  const result = await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, (event) => s.events.push(event));
  assert.equal(result.failed, true);
  assert.equal(s.inputs.length, 2);
  assert.equal(fs.existsSync(s.modelPath), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.folder, 'validation.json'), 'utf8')).valid, false);
  assert.ok(s.events.some((event) => event.type === 'design' && !event.valid));
});

test('开放区被封闭房间隔开时直接接受分配，保存完整墙体且不自动开门', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    fs.writeFileSync(s.layoutPath, JSON.stringify({
      splits: [{ regionId: 'r1', axis: 'x', ratio: 0.3 }, { regionId: 'r1.b', axis: 'x', ratio: 0.5 }],
      allocations: [
        { id: 'front', usage: '前台', enclosed: false, regionIds: ['r1.a'] },
        { id: 'room', usage: '团操室', enclosed: true, regionIds: ['r1.b.a'] },
        { id: 'training', usage: '训练区', enclosed: false, regionIds: ['r1.b.b'] },
      ],
    }));
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
  assert.equal(s.inputs.length, 1);
  const model = JSON.parse(fs.readFileSync(s.modelPath, 'utf8'));
  assert.deepEqual(model.spaces.map((space: { id: string }) => space.id), ['front', 'room', 'training']);
  assert.equal(model.walls.length, 6);
  assert.deepEqual(model.openings, []);
  assert.deepEqual(model.doors, []);
  assert.equal(validateStoredDesign(model).valid, true);
  const validation = JSON.parse(fs.readFileSync(path.join(s.folder, 'validation.json'), 'utf8'));
  assert.deepEqual(validation.assumptions, []);
  assert.deepEqual(validation.warnings, []);
});

test('旧会话直接写几何时隔离文件，要求改用区域分配', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length === 1) fs.writeFileSync(s.modelPath, JSON.stringify(s.model));
    else {
      assert.match(input.message, /直接写入 model.json/);
      assert.equal(fs.existsSync(s.modelPath), false);
      fs.writeFileSync(s.layoutPath, JSON.stringify(validPlan()));
    }
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
  assert.equal(fs.existsSync(path.join(s.folder, 'agent-model.rejected.json')), true);
});

test('要求铺满时遗漏子区域需修正；概念讨论无需提交文件', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length > 1) assert.match(input.message, /r1.b/);
    fs.writeFileSync(s.layoutPath, JSON.stringify({ splits: [{ regionId: 'r1', axis: 'x', ratio: 0.5 }], ...validPlan(s.inputs.length === 1 ? ['r1.a'] : ['r1.a', 'r1.b']) }));
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: { ...s.outline, requireFullCoverage: true }, revisionId: 'rev-0001', message: '铺满轮廓' }, adapter, () => {})).failed, false);
  assert.equal(s.inputs.length, 2);
  let calls = 0;
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0002', message: '为什么这样布局？' }, {
    id: 'test', async run() { calls++; return { failed: false }; },
  }, () => {})).failed, false);
  assert.equal(calls, 1);
});

test('损坏 JSON 可修正，实际错误文件随反馈返回', async (t) => {
  const s = setup(t);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    s.inputs.push(input);
    if (s.inputs.length === 1) fs.writeFileSync(s.layoutPath, '{broken');
    else {
      assert.match(input.message, /\{broken/);
      fs.writeFileSync(s.layoutPath, JSON.stringify(validPlan()));
    }
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: s.outline, revisionId: 'rev-0001', message: '生成' }, adapter, () => {})).failed, false);
  assert.equal(s.inputs.length, 2);
});

test('修改只提交新分配，父文件、固定墙及门窗由程序保留', async (t) => {
  const s = setup(t);
  s.model.walls[0].fixed = true;
  s.model.openings = [{ id: 'entry', hostWallId: 'wall-0', position: 5, width: 1, height: 2.1 }];
  s.model.doors = [{ id: 'door-1', openingId: 'entry', swing: 'none', leafCount: 1, analysisProperties: {} }];
  fs.mkdirSync(s.folder, { recursive: true });
  const parentJson = JSON.stringify(s.model);
  fs.writeFileSync(s.modelPath, parentJson);
  const adapter: ProviderAdapter = { id: 'test', async run(input) {
    assert.match(input.systemPrompt ?? '', /当前分配/);
    assert.match(input.systemPrompt ?? '', /entry/);
    fs.writeFileSync(path.join(s.cwd, 'designs', 'rev-0002', 'layout.json'), JSON.stringify(validPlan()));
    return { failed: false };
  } };
  assert.equal((await runSpaceTurn({ cwd: s.cwd, outline: loadOutlineContext(s.cwd, s.model), revisionId: 'rev-0002', message: '调整布局' }, adapter, () => {})).failed, false);
  assert.equal(fs.readFileSync(s.modelPath, 'utf8'), parentJson);
  const child = JSON.parse(fs.readFileSync(path.join(s.cwd, 'designs', 'rev-0002', 'model.json'), 'utf8'));
  assert.equal(child.model.parentRevisionId, 'rev-0001');
  assert.deepEqual(child.doors, s.model.doors);
  assert.deepEqual(child.walls.find((wall: {id:string}) => wall.id === 'wall-0'), s.model.walls[0]);
});

test('铺满要求跨轮次继承，明确取消时解除', () => {
  assert.equal(resolveFullCoverage('健身房，铺满轮廓无 void'), true);
  assert.equal(resolveFullCoverage('扩大团操室', true), true);
  assert.equal(resolveFullCoverage('不用铺满，保留空白', true), false);
  assert.equal(resolveFullCoverage('不必铺满，但最后还是全覆盖'), true);
});
