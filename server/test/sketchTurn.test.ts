import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SketchExtraction, StreamEvent } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import type { ChatTurnInput, ProviderAdapter } from '../src/providers/types';
import { imageAttachments, claudeInput } from '../src/providers/images';
import { buildCommand } from '../src/providers/claude';
import { runSketchTurn, readSketchReport } from '../src/sketch/runSketchTurn';
import { hashJson, loadSketch, saveSketch, writeJson } from '../src/sketch/store';
import { workspacesDir } from '../src/config';
import { confirmSketch } from '../src/routes/sketches';
import { isAcceptedDesign } from '../src/model/store';
import { sketchFixture } from './helpers/sketch';

async function setup(t: TestContext) {
  const sessionId = `test-sketch-${randomUUID()}`, cwd = path.join(workspacesDir, sessionId);
  fs.mkdirSync(cwd, { recursive: true });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bytes = await sharp(new URL('./fixtures/sketch-two-room.svg', import.meta.url).pathname).png().toBuffer();
  const source = await saveSketch(cwd, '草图.png', bytes);
  const extraction = sketchFixture(); extraction.sketchId = source.id;
  return { sessionId, cwd, bytes, source, extraction };
}

function adapterFor(extraction: SketchExtraction, calls: ChatTurnInput[]): ProviderAdapter {
  return { id: 'mock', async run(input) {
    calls.push(input);
    const relative = input.systemPrompt!.match(/designs\/(rev-\d+)\//)![1];
    const folder = path.join(input.cwd, 'designs', relative);
    if (input.systemPrompt!.includes('sketch-patch.json')) {
      const current = JSON.parse(fs.readFileSync(path.join(folder, 'sketch.json'), 'utf8'));
      writeJson(path.join(folder, 'sketch-patch.json'), { sketchId: extraction.sketchId, baseHash: hashJson(current), labels: { upsert: [{ ...current.labels[1], text: '书房', usage: '书房' }] } });
    } else writeJson(path.join(folder, 'sketch.json'), extraction);
    return { failed: false, nativeSessionId: 'mock-native' };
  } };
}

test('同名重复上传创建不同版本；原图保留，active 指向最新图，非图像被拒绝', async (t) => {
  const s = await setup(t);
  const second = await saveSketch(s.cwd, '草图.png', s.bytes);
  assert.notEqual(second.id, s.source.id);
  assert.equal(second.sha256, s.source.sha256);
  assert.equal(loadSketch(s.cwd)?.id, second.id);
  assert.deepEqual(fs.readFileSync(path.join(s.cwd, s.source.originalPath)), s.bytes);
  assert.equal(loadSketch(s.cwd, s.source.id)?.id, s.source.id);
  await assert.rejects(saveSketch(s.cwd, 'fake.png', Buffer.from('not an image')));
});

test('图片附件包含实际字节，Claude 使用图片内容块和 Read 权限', async (t) => {
  const s = await setup(t);
  const input: ChatTurnInput = { cwd: s.cwd, message: '识别', images: [{ path: s.source.imagePath, mimeType: 'image/png', width: 1000, height: 800 }] };
  const images = imageAttachments(input);
  assert.deepEqual(Buffer.from(images[0].data, 'base64'), fs.readFileSync(path.join(s.cwd, s.source.imagePath)));
  const message = JSON.parse(claudeInput(input));
  assert.equal(message.message.content[0].source.media_type, 'image/png');
  assert.equal(message.message.content[1].text, '识别');
  assert.ok(buildCommand(input).args.includes('Read,Write'));
  assert.ok(buildCommand(input).args.includes('--input-format'));
  assert.ok(buildCommand({ ...input, imagePhase: 'extract' }).args.includes('Write'));
  assert.throws(() => imageAttachments({ ...input, images: [{ ...input.images![0], path: '../../package.json' }] }));
});

test('几何有效的还原只调用一次模型，直接编译并记录每个阶段耗时', async (t) => {
  const s = await setup(t), calls: ChatTurnInput[] = [], events: StreamEvent[] = [];
  writeJson(path.join(s.cwd, 'inputs/outline.json'), { boundary: [[0, 0], [1, 0], [1, 1], [0, 0]], units: 'm', origin: [0, 0] });
  const out = await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapterFor(s.extraction, calls), (e) => events.push(e));
  assert.equal(out.failed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].nativeSessionId, undefined);
  assert.equal(calls[0].images?.length, 1);
  const report = readSketchReport(s.cwd, 'rev-0001')!;
  assert.equal(report.status, 'accepted');
  assert.equal(report.model!.spaces.reduce((n, room) => n + room.targetArea, 0), 48, '不沿用旧 outline');
  assert.equal(isAcceptedDesign(s.sessionId, 'rev-0001'), true);
  assert.ok(events.some((e) => e.type === 'sketchReview' && e.status === 'accepted'));
  assert.ok(fs.statSync(path.join(s.cwd, report.overlayPath!)).size > 100);
  assert.equal(report.visualReview, undefined);
  assert.equal(fs.existsSync(path.join(s.cwd, 'designs/rev-0001/sketch-review.json')), false);
  assert.ok(s.source.preparationMs! > 0);
  const timing = JSON.parse(fs.readFileSync(path.join(s.cwd, 'designs/rev-0001/sketch-timing.json'), 'utf8'));
  assert.deepEqual(report.timings, timing);
  assert.deepEqual(timing.stages.map((stage: { phase: string }) => stage.phase), ['recognize', 'parse', 'compile', 'overlay', 'persist']);
  assert.ok(timing.completedAt);
  assert.ok(timing.durationMs >= timing.stages.reduce((n: number, stage: { durationMs: number }) => n + stage.durationMs, 0) - 0.01);
});

test('无比例是可查看草案，补充实长并明确确认后保存新版本', async (t) => {
  const s = await setup(t), calls: ChatTurnInput[] = [];
  s.extraction.dimensions = []; s.extraction.heightM = null;
  await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapterFor(s.extraction, calls), () => {});
  const draft = readSketchReport(s.cwd, 'rev-0001')!;
  assert.equal(draft.status, SKETCH_HUMAN_REVIEW_ENABLED ? 'needs_review' : 'accepted');
  assert.equal(calls.length, 1, '缺少尺寸直接返回草案，不触发额外模型调用');
  assert.equal(isAcceptedDesign(s.sessionId, 'rev-0001'), !SKETCH_HUMAN_REVIEW_ENABLED);
  await assert.rejects(confirmSketch(s.cwd, draft, { confirm: true, extractionHash: draft.extractionHash }), /实长/);
  const accepted = await confirmSketch(s.cwd, draft, { confirm: true, extractionHash: draft.extractionHash, wallId: 'W1', lengthM: 8 });
  assert.equal(accepted.revisionId, 'rev-0002');
  assert.equal(accepted.status, 'accepted');
  assert.equal(isAcceptedDesign(s.sessionId, accepted.revisionId), true);
  if (SKETCH_HUMAN_REVIEW_ENABLED) {
    assert.equal(readSketchReport(s.cwd, 'rev-0001')!.status, 'needs_review');
  }
});

test('后续定点修正只调用一次模型，保留其他对象并产生新哈希', async (t) => {
  const s = await setup(t), calls: ChatTurnInput[] = [];
  const adapter = adapterFor(s.extraction, calls);
  await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapter, () => {});
  const previous = readSketchReport(s.cwd, 'rev-0001')!;
  await runSketchTurn({ ...s, revisionId: 'rev-0002', message: 'L2 是书房', previous }, adapter, () => {});
  const result = readSketchReport(s.cwd, 'rev-0002')!;
  assert.deepEqual(result.extraction!.walls, previous.extraction!.walls);
  assert.deepEqual(result.extraction!.openings, previous.extraction!.openings);
  assert.equal(result.extraction!.labels[1].text, '书房');
  assert.notEqual(result.extractionHash, previous.extractionHash);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].imagePhase, 'patch');
  assert.equal(calls[1].images?.length, 1);
  assert.equal(result.visualReview, undefined);
  assert.equal(result.timings!.stages.filter((stage) => stage.phase === 'patch').length, 1);
});

test('失效宿主只产生 review 提示，不再触发修正循环或拒绝', async (t) => {
  const s = await setup(t), calls: ChatTurnInput[] = [];
  s.extraction.openings[0].wallId = 'missing-wall';
  await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapterFor(s.extraction, calls), () => {});
  const report = readSketchReport(s.cwd, 'rev-0001')!;
  assert.equal(report.status, 'accepted');
  assert.equal(calls.length, 1, '缺信息不触发补丁循环');
  assert.ok(report.issues.some((i) => i.id === 'host-D1' && i.severity === 'review'));
  assert.equal(isAcceptedDesign(s.sessionId, 'rev-0001'), true);
});

test('格式校验失败只重试识别，成功后不再复核，失败阶段也有计时', async (t) => {
  const s = await setup(t), calls: ChatTurnInput[] = [];
  const base = adapterFor(s.extraction, calls);
  const adapter: ProviderAdapter = { id: 'mock', async run(input, emit, signal) {
    const result = await base.run(input, emit, signal);
    if (calls.length === 1) writeJson(path.join(s.cwd, 'designs/rev-0001/sketch.json'), {
      ...s.extraction, dimensions: [{ ...s.extraction.dimensions[0], lengthM: null }],
    });
    return { ...result, timings: { totalMs: 1, runMs: 1 } };
  } };
  const result = await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapter, () => {});
  assert.equal(result.failed, false);
  assert.deepEqual(calls.map((c) => c.imagePhase), ['extract', 'extract']);
  const report = readSketchReport(s.cwd, 'rev-0001')!;
  assert.deepEqual(report.timings!.stages.filter((s) => s.phase === 'parse').map((s) => [s.attempt, s.outcome]), [[1, 'failed'], [2, 'completed']]);
  assert.deepEqual(report.timings!.stages[0].provider, { totalMs: 1, runMs: 1 });
});

test('未生成的未知开口不再阻断确认，保留为提示', async (t) => {
  const s = await setup(t); s.extraction.openings[0].kind = 'unknown';
  await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapterFor(s.extraction, []), () => {});
  const report = readSketchReport(s.cwd, 'rev-0001')!;
  const accepted = await confirmSketch(s.cwd, report, { confirm: true, extractionHash: report.extractionHash });
  assert.equal(accepted.status, 'accepted');
  assert.equal(isAcceptedDesign(s.sessionId, accepted.revisionId), true);
});

test('模型明确报告不支持图片时立即停止，不退回文字猜测或反复重试', async (t) => {
  const s = await setup(t); let calls = 0;
  const adapter: ProviderAdapter = { id: 'text-only', async run(_input, emit) {
    calls++; emit({ type: 'text', text: '图片显示为 [Unsupported Image]，无法识别。' }); return { failed: false };
  } };
  const out = await runSketchTurn({ ...s, revisionId: 'rev-0001', message: '还原' }, adapter, () => {});
  assert.equal(out.failed, true);
  assert.equal(calls, 1);
  const report = readSketchReport(s.cwd, 'rev-0001')!;
  assert.match(report.issues[0].message, /代理未接收图片/);
  assert.equal(report.model, undefined);
  assert.equal(report.timings!.stages[0].outcome, 'failed');
  assert.ok(report.timings!.completedAt);
});
