import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { OptimizationCandidate } from '@sdd/shared';
import { workspacesDir } from '../src/config';
import { listDesigns, loadDesign, saveDesign } from '../src/model/store';
import { compareCandidate, recommendCandidate } from '../src/optimization/evaluate';
import { parseAutomaticOptimizationRequest, prepareAutomaticOptimization, selectAutomaticDoor } from '../src/optimization/automatic';
import { candidateWidths, validateOptimizationModel, widenDoor } from '../src/optimization/patch';
import { parseProposal } from '../src/optimization/planner';
import { adoptOptimization, parseOptimizationRequest, prepareOptimization, runOptimization } from '../src/optimization/run';
import { loadOptimization, optimizationDir, saveOptimization, writeJson } from '../src/optimization/store';
import { handleAutomaticOptimization, handleOptimization } from '../src/routes/optimizations';
import type { ProviderAdapter } from '../src/providers/types';
import { compileSketch } from '../src/sketch/compile';
import { sketchFixture, sketchSource } from './helpers/sketch';
import { evaluation, optimizationModel, optimizationPedestrian, optimizationRequest, optimizationSunlight } from './helpers/optimization';

function fixture(withConfigs = true) {
  const id = `optimization-test-${randomUUID()}`;
  const model = optimizationModel();
  saveDesign(id, model);
  const dir = path.join(workspacesDir, id, 'designs', 'rev-0001');
  if (withConfigs) {
    writeJson(path.join(dir, 'sunlight.json'), optimizationSunlight);
    writeJson(path.join(dir, 'pedestrian.json'), optimizationPedestrian);
  }
  return { id, model, request: optimizationRequest(id), cleanup: () => fs.rmSync(path.join(workspacesDir, id), { recursive: true, force: true }) };
}

const adapter: ProviderAdapter = { id: 'fixture', async run(input) {
  const context = JSON.parse(fs.readFileSync(path.join(input.cwd, 'input.json'), 'utf8'));
  writeJson(path.join(input.cwd, 'proposal.json'), { schemaVersion: 1, status: 'ready', summary: '比较两档门洞增宽',
    candidates: context.allowedWidths.map((widthM: number) => ({ operations: [{ type: 'resizeOpening', widthM }], rationale: '检验门宽限制疏散的假设' })) });
  return { failed: false };
} };

test('门洞补丁只改变授权宽度，保留对象、功能、固定墙和原始模型', () => {
  const model = optimizationModel(), before = structuredClone(model), request = optimizationRequest('test');
  validateOptimizationModel(model);
  assert.deepEqual(candidateWidths(request), [1.1, 1.4]);
  const child = widenDoor(model, request, 1.1);
  assert.equal(child.openings[0].width, 1.1);
  child.openings[0].width = 0.8;
  assert.deepEqual(child, before);
  assert.deepEqual(model, before);
});

test('拒绝越权、尺寸冲突、固定结构、相邻洞口和墙交点', () => {
  const request = optimizationRequest('test');
  assert.throws(() => widenDoor(optimizationModel(), { ...request, confirmEditable: false }, 1.1), /允许改造/);
  assert.throws(() => widenDoor(optimizationModel(), { ...request, expectedWidthM: 0.9 }, 1.1), /尺寸已变化/);
  assert.throws(() => widenDoor(optimizationModel(), request, 1.5), /上限/);
  for (const field of ['fixed', 'role', 'catalog'] as const) {
    const m = optimizationModel(), w = m.walls.at(-1)!;
    if (field === 'fixed') w.fixed = true;
    if (field === 'role') w.role = 'structural';
    if (field === 'catalog') w.analysisProperties = { typeId: 'wall-shear-300' };
    assert.throws(() => widenDoor(m, request, 1.1), /修改范围/);
  }
  const overlap = optimizationModel();
  overlap.openings.push({ ...overlap.openings[0], id: 'another', position: 5.8, width: 0.4 });
  assert.throws(() => widenDoor(overlap, request, 1.4), /相邻门窗/);
  const junction = optimizationModel();
  junction.walls.push({ id: 'branch', geometry: { type: 'polyline', points: [[10, 5.6], [14, 5.6]] }, thickness: 0.2, height: 3, fixed: false });
  assert.throws(() => widenDoor(junction, request, 1.4), /连接位置冲突/);
});

test('首轮拒绝未经支持的单位、包围盒空白、固定设施和无效请求', () => {
  const m = optimizationModel(); m.model.units = 'mm';
  assert.throws(() => validateOptimizationModel(m));
  const open = optimizationModel(); open.walls.pop(); open.walls.pop();
  assert.throws(() => validateOptimizationModel(open));
  const fixed = optimizationModel();
  fixed.fixedContext.push({ id: 'column', kind: 'column', geometry: { type: 'polyline', points: [[4, 4], [4, 5]] } });
  assert.throws(() => validateOptimizationModel(fixed), /固定设施/);
  assert.throws(() => parseOptimizationRequest({ ...optimizationRequest('../escape') }));
  assert.throws(() => parseOptimizationRequest({ ...optimizationRequest('s'), provider: 'echo' }));
});

test('比较先保护日照、人数、测点和工况；不能把未清空或缺失结果当改善', () => {
  const base = evaluation(), better = evaluation(18);
  assert.equal(compareCandidate(base, better).improved, true);
  for (const mutate of [
    (n: typeof better) => { n.sunlight.spaces[0].meanHours = 0.9; },
    (n: typeof better) => { n.sunlight.spaces[0].minHours = -0.1; },
    (n: typeof better) => { n.sunlight.spaces[0].targetMetRatio = null; },
    (n: typeof better) => { n.sunlight.spaces[0].sampledArea = 0; },
    (n: typeof better) => { n.sunlight.spaces.pop(); },
    (n: typeof better) => { n.pedestrian.totalAgents--; },
    (n: typeof better) => { n.pedestrian.egressTimeSec = null; },
    (n: typeof better) => { n.scenarioHash = 'different'; },
    (n: typeof better) => { n.sunlight.engineVersion = 'different'; },
  ]) {
    const next = structuredClone(better); mutate(next);
    assert.equal(compareCandidate(base, next).eligible, false);
  }
  assert.equal(compareCandidate(base, evaluation(19.95)).improved, false);
  assert.equal(compareCandidate(base, evaluation(19.9)).improved, false);
  const incomplete = evaluation(); incomplete.pedestrian.egressTimeSec = null;
  assert.equal(compareCandidate(incomplete, better).improved, true);
});

test('近似并列时优先小改动，失败候选不能参与推荐', () => {
  const candidate = (id: string, widthM: number, time: number): OptimizationCandidate => ({
    id, patch: { type: 'resizeOpening', openingId: 'inside', expectedWidthM: 0.8, widthM, maxWidthM: 1.4 }, rationale: '', status: 'completed', evaluation: evaluation(time), assessment: compareCandidate(evaluation(), evaluation(time)),
  });
  const small = candidate('small', 1.1, 18.05), large = candidate('large', 1.4, 18);
  assert.equal(recommendCandidate([large, small]), 'small');
  small.status = 'failed';
  assert.equal(recommendCandidate([large, small]), 'large');
  assert.equal(recommendCandidate([candidate('unchanged', 1.1, 20)]), undefined);
});

test('Agent 输出严格限制为允许的宽度/门位/隔墙、个数和字段，支持明确返回缺项', () => {
  const ready = { schemaVersion: 1, status: 'ready', summary: '缩短疏散时间', candidates: [{ operations: [{ type: 'resizeOpening', widthM: 1.1 }], rationale: '试算' }] };
  assert.equal(parseProposal(ready, [1.1, 1.4], [], [], [], [], []).status, 'ready');
  assert.throws(() => parseProposal({ ...ready, population: 1 }, [1.1], [], [], [], [], []));
  assert.throws(() => parseProposal(ready, [1.4], [], [], [], [], []));
  assert.throws(() => parseProposal({ ...ready, candidates: [...ready.candidates, ...ready.candidates] }, [1.1], [], [], [], [], []));
  assert.equal(parseProposal({ schemaVersion: 1, status: 'needs_input', summary: '本轮无法修改隔墙', candidates: [] }, [1.1], [], [], [], [], []).status, 'needs_input');
});

test('parseProposal 接受 offsetPartition 候选并校验墙与偏移组合', () => {
  const ready = { schemaVersion: 1, status: 'ready', summary: '日照驱动', candidates: [{ operations: [{ type: 'offsetPartition', wallId: 'partition', offsetM: 0.3 }], rationale: '试算' }] };
  assert.equal(parseProposal(ready, [], [], [{ wallId: 'partition', offsetM: 0.3 }], [], [], []).status, 'ready');
  assert.throws(() => parseProposal(ready, [], [], [{ wallId: 'partition', offsetM: -0.3 }], [], [], []), /允许的隔墙/);
  assert.throws(() => parseProposal(ready, [], [], [{ wallId: 'other', offsetM: 0.3 }], [], [], []), /允许的隔墙/);
});

test('parseProposal 接受 swapProgram 候选并校验交换对', () => {
  const ready = { schemaVersion: 1, status: 'ready', summary: '功能交换', candidates: [{ operations: [{ type: 'swapProgram', spaceA: 'roomA', spaceB: 'roomB' }], rationale: '试算' }] };
  assert.equal(parseProposal(ready, [], [], [], [{ spaceA: 'roomA', spaceB: 'roomB' }], [], []).status, 'ready');
  assert.throws(() => parseProposal(ready, [], [], [], [{ spaceA: 'roomB', spaceB: 'roomA' }], [], []), /允许的功能交换/);
});

test('parseProposal 接受外窗候选并校验 openingId+宽度/位置', () => {
  const win = { operations: [{ type: 'resizeWindow', openingId: 'win1', widthM: 1.5 }], rationale: '试算' };
  assert.equal(parseProposal({ schemaVersion: 1, status: 'ready', summary: '日照', candidates: [win] }, [], [], [], [],
    [{ type: 'resizeWindow', openingId: 'win1', expectedWidthM: 1.2, widthM: 1.5, maxWidthM: 1.6 }], []).status, 'ready');
  assert.throws(() => parseProposal({ schemaVersion: 1, status: 'ready', summary: '日照', candidates: [win] }, [], [], [], [], [], []), /外窗宽度/);
});

test('parseProposal 接受多操作组合候选', () => {
  const combo = { schemaVersion: 1, status: 'ready', summary: '组合方案',
    candidates: [{ operations: [{ type: 'resizeOpening', widthM: 1.1 }, { type: 'offsetPartition', wallId: 'partition', offsetM: 0.3 }], rationale: '组合试算' }] };
  assert.equal(parseProposal(combo, [1.1, 1.4], [], [{ wallId: 'partition', offsetM: 0.3 }], [], [], []).status, 'ready');
  assert.throws(() => parseProposal({ ...combo, candidates: [{ operations: [], rationale: '空' }] }, [1.1], [], [], [], [], []), /至少 1 个操作/);
});

test('闭环保存证据和候选；采用才创建版本，保留工况，重复采用幂等', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run, model } = prepareOptimization(f.request);
  const widths: number[] = [];
  await runOptimization(run, model, () => {}, new AbortController().signal, { adapter,
    evaluate: async (m, state) => {
      const width = m.openings[0].width; widths.push(width);
      return { ...evaluation(width === 0.8 ? 20 : width === 1.1 ? 18 : 17), scenarioHash: state.scenarioHash };
    } });
  assert.deepEqual(widths, [0.8, 1.1, 1.4]);
  assert.equal(run.status, 'completed'); assert.equal(run.recommendedCandidateId, 'candidate-2');
  assert.equal(listDesigns(f.id).length, 1);
  assert.throws(() => adoptOptimization(f.id, run.id, 'candidate-2', 'rev-0002'), /已切换/);
  const rev = adoptOptimization(f.id, run.id, 'candidate-2', 'rev-0001');
  assert.equal(rev, 'rev-0002');
  assert.equal(adoptOptimization(f.id, run.id, 'candidate-2', 'rev-0001'), rev);
  assert.equal(listDesigns(f.id).length, 2);
  assert.equal(loadDesign(f.id, rev)?.model.parentRevisionId, 'rev-0001');
  assert.equal(loadDesign(f.id, 'rev-0001')?.openings[0].width, 0.8);
  assert.equal(loadDesign(f.id, rev)?.openings[0].width, 1.4);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspacesDir, f.id, 'designs', rev, 'pedestrian.json'), 'utf8')), optimizationPedestrian);
});

test('无改善不推荐、不产生正式方案', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run, model } = prepareOptimization(f.request);
  await runOptimization(run, model, () => {}, new AbortController().signal, { adapter,
    evaluate: async (m, state) => ({ ...evaluation(), scenarioHash: state.scenarioHash }) });
  assert.equal(run.outcome, 'no_improvement');
  assert.equal(run.recommendedCandidateId, undefined);
  assert.equal(listDesigns(f.id).length, 1);
});

test('采用时拒绝变化的基线工况和候选文件', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run, model } = prepareOptimization(f.request);
  await runOptimization(run, model, () => {}, new AbortController().signal, { adapter,
    evaluate: async (m, state) => ({ ...evaluation(m.openings[0].width === 0.8 ? 20 : 18), scenarioHash: state.scenarioHash }) });
  const configFile = path.join(workspacesDir, f.id, 'designs/rev-0001/pedestrian.json');
  writeJson(configFile, { ...optimizationPedestrian, seed: 2 });
  assert.throws(() => adoptOptimization(f.id, run.id, 'candidate-1', 'rev-0001'), /设置已变化/);
  writeJson(configFile, optimizationPedestrian);
  writeJson(path.join(optimizationDir(f.id, run.id), 'candidate-1.json'), model);
  assert.throws(() => adoptOptimization(f.id, run.id, 'candidate-1', 'rev-0001'), /候选模型已变化/);
});

test('取消停止后续调用；重启遗留状态标为 interrupted', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run, model } = prepareOptimization(f.request);
  const abort = new AbortController(); let calls = 0;
  await runOptimization(run, model, () => {}, abort.signal, { adapter,
    evaluate: async () => { calls++; abort.abort(new Error('停止')); return evaluation(); } });
  assert.equal(calls, 1); assert.equal(run.status, 'cancelled');
  assert.equal(run.candidates.length, 0);
  run.status = 'evaluating'; saveOptimization(run);
  assert.equal(loadOptimization(f.id, run.id).status, 'interrupted');
});

test('一键优化无需预先运行仿真，自动建工况并走同一候选与采用闭环（模拟求解器）', async (t) => {
  const f = fixture(false); t.after(f.cleanup);
  const input = parseAutomaticOptimizationRequest({ sessionId: f.id, revisionId: 'rev-0001', provider: 'cursor' });
  const { run, model } = prepareAutomaticOptimization(input);
  assert.deepEqual(run.automatic?.createdConfigs, ['sunlight', 'pedestrian']);
  assert.equal(run.request.openingId, 'inside');
  assert.deepEqual(candidateWidths(run.request), [0.9, 1]);
  assert.equal(run.configs.sunlight.targets, undefined, '默认配置不得引用示例中的空间或冒充用户目标');
  assert.deepEqual(run.configs.pedestrian.agents, [{ spaceId: 'roomA', count: 13 }, { spaceId: 'roomB', count: 13 }]);
  const widths: number[] = [];
  await runOptimization(run, model, () => {}, new AbortController().signal, { adapter,
    evaluate: async (m, state) => {
      widths.push(m.openings[0].width);
      const result = evaluation(m.openings[0].width === 0.8 ? 20 : 18);
      result.pedestrian.totalAgents = 26;
      return { ...result, scenarioHash: state.scenarioHash };
    } });
  assert.deepEqual(widths, [0.8, 0.9, 1]);
  assert.equal(run.recommendedCandidateId, 'candidate-1');
  assert.equal(listDesigns(f.id).length, 1, '自动试算不应自动采用');
  assert.equal(adoptOptimization(f.id, run.id, 'candidate-1', 'rev-0001'), 'rev-0002');
  assert.equal(loadDesign(f.id, 'rev-0001')?.openings[0].width, 0.8);
  assert.equal(loadDesign(f.id, 'rev-0002')?.openings[0].width, 0.9);
});

test('一键优化保留已有设置，无效工况不能被默认值覆盖', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run } = prepareAutomaticOptimization(f.request);
  assert.deepEqual(run.automatic?.createdConfigs, []);
  assert.deepEqual(run.configs.pedestrian, optimizationPedestrian);
  assert.equal(run.configs.sunlight.analysisDate, optimizationSunlight.analysisDate);
  const file = path.join(workspacesDir, f.id, 'designs/rev-0001/sunlight.json');
  const invalid = { ...optimizationSunlight, targets: [{ spaceIds: ['missing-room'], minHours: 2 }] };
  writeJson(file, invalid);
  assert.throws(() => prepareAutomaticOptimization(f.request), /不存在的空间/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), invalid);
});

test('实际草图编译结果可直接准备优化，开放标记不导致默认人数为空', (t) => {
  const f = fixture(false); t.after(f.cleanup);
  const extraction = sketchFixture();
  extraction.openings.push({ ...extraction.openings[0], id: 'D2', wallId: 'W1', position: 0.75 });
  const compiled = compileSketch(extraction, sketchSource, 'rev-0001');
  assert.equal(compiled.calibrated, true);
  const model = compiled.model!;
  model.model.sketchStatus = 'accepted';
  assert.ok(model.spaces.every((s) => s.enclosed === false));
  const dir = path.join(workspacesDir, f.id, 'designs/rev-0001');
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'sketch-report.json'), compiled);
  const { run } = prepareAutomaticOptimization(f.request);
  assert.deepEqual(run.configs.pedestrian.agents, model.spaces.map((s) => ({ spaceId: s.id, count: 3 })));
  assert.equal(run.request.openingId, 'D1');
  assert.deepEqual(loadDesign(f.id, 'rev-0001'), model, '生成默认人数不改模型的空间属性');
});

test('自动选门排除结构、固定及几何冲突；无可改门洞或缺尺寸时先报告缺项', (t) => {
  const f = fixture(false); t.after(f.cleanup);
  const m = optimizationModel();
  m.openings.find((o) => o.id === 'exit')!.width = 0.7;
  assert.equal(selectAutomaticDoor(f.request, m).openingId, 'inside', '固定外墙上更窄的门不能被选中');
  m.walls.at(-1)!.analysisProperties = { typeId: 'wall-shear-300' };
  assert.throws(() => selectAutomaticDoor(f.request, m), /未找到可增宽/);
  const dir = path.join(workspacesDir, f.id, 'designs/rev-0001');
  writeJson(path.join(dir, 'model.json'), m);
  assert.throws(() => prepareAutomaticOptimization(f.request), /未找到可增宽/);
  assert.equal(fs.existsSync(path.join(dir, 'sunlight.json')), false);
  const uncalibrated = optimizationModel(); uncalibrated.model.sketchId = 'sketch-test';
  writeJson(path.join(dir, 'model.json'), uncalibrated);
  assert.throws(() => prepareAutomaticOptimization(f.request), /真实尺寸/);
  assert.equal(fs.existsSync(path.join(dir, 'pedestrian.json')), false);
});

test('优化 HTTP 入口在开流前拒绝非法路径和未确认编辑权限', async () => {
  for (const body of [optimizationRequest('../escape'), { ...optimizationRequest('abc'), confirmEditable: false }]) {
    let status = 200; let data: unknown;
    const req = Object.assign(new EventEmitter(), { body }) as Request;
    const res = { status(code: number) { status = code; return this; }, json(value: unknown) { data = value; } } as Response;
    await handleOptimization(req, res);
    assert.equal(status, 400); assert.ok(data);
  }
  for (const body of [null, { sessionId: '../escape', revisionId: 'rev-0001', provider: 'cursor' },
    { sessionId: 'valid', revisionId: 'rev-0001', provider: 'echo' }]) {
    let status = 200;
    const req = { body } as Request;
    const res = { status(code: number) { status = code; return this; }, json() {} } as unknown as Response;
    await handleAutomaticOptimization(req, res);
    assert.equal(status, 400);
  }
});

test('Agent 提案的候选通过补丁管线被应用', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { run, model } = prepareOptimization(f.request);
  const widths: number[] = [];
  await runOptimization(run, model, () => {}, new AbortController().signal, { adapter,
    evaluate: async (m, state) => {
      widths.push(m.openings[0].width);
      return { ...evaluation(18), scenarioHash: state.scenarioHash };
    } });
  assert.equal(run.candidates.length, 2);
  assert.deepEqual(widths, [0.8, 1.1, 1.4]);
});
