import fs from 'node:fs';
import path from 'node:path';
import type { SketchExtraction, SketchReport, SketchSource, SketchStageTiming, SketchTimings, StreamEvent } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import type { ChatTurnInput, ProviderAdapter, TurnResult } from '../providers/types';
import { compileSketch } from './compile';
import { parseExtraction, applyExtractionPatch } from './parse';
import { renderSketchOverlay } from './overlay';
import { sketchExtractionPrompt, sketchPatchPrompt } from './prompts';
import { hashJson, writeJson } from './store';

class UnsupportedSketchImageError extends Error {}

function sketchValidationValid(report: SketchReport): boolean {
  if (report.status === 'accepted') return true;
  return !SKETCH_HUMAN_REVIEW_ENABLED && report.geometryValid && report.status !== 'rejected';
}

function resolveGeometryValidStatus(needsHumanReview: boolean): SketchReport['status'] {
  if (!SKETCH_HUMAN_REVIEW_ENABLED) return 'accepted';
  return needsHumanReview ? 'needs_review' : 'accepted';
}

export function saveSketchReport(cwd: string, report: SketchReport): void {
  const folder = path.join(cwd, 'designs', report.revisionId);
  if (report.model) {
    report.model.model.sketchStatus = report.status;
    writeJson(path.join(folder, 'model.json'), report.model);
  } else if (fs.existsSync(path.join(folder, 'model.json'))) {
    fs.renameSync(path.join(folder, 'model.json'), path.join(folder, 'agent-model.rejected.json'));
  }
  writeJson(path.join(folder, 'sketch-report.json'), report);
  writeJson(path.join(folder, 'validation.json'), {
    valid: sketchValidationValid(report), status: report.status,
    geometryValid: report.geometryValid, calibrated: report.calibrated,
    errors: report.issues.filter((i) => i.severity === 'error').map((i) => i.message),
    warnings: report.issues.filter((i) => i.severity === 'review').map((i) => i.message),
    sketchId: report.source.id,
  });
}

export function readSketchReport(cwd: string, revisionId: string): SketchReport | null {
  if (!/^rev-\d+$/.test(revisionId)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(cwd, 'designs', revisionId, 'sketch-report.json'), 'utf8')) as SketchReport; }
  catch { return null; }
}

export async function runSketchTurn(input: {
  cwd: string; revisionId: string; source: SketchSource; message: string; model?: string;
  previous?: SketchReport;
}, adapter: ProviderAdapter, emit: (event: StreamEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
  const { cwd, revisionId, source } = input;
  const folder = path.join(cwd, 'designs', revisionId);
  fs.mkdirSync(folder, { recursive: true });
  const started = performance.now();
  const timings: SketchTimings = { startedAt: new Date().toISOString(), durationMs: 0, stages: [] };
  const elapsed = (start: number) => Math.round((performance.now() - start) * 1000) / 1000;
  const timed = async <T>(phase: SketchStageTiming['phase'], attempt: number, action: (stage: SketchStageTiming) => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    const stage: SketchStageTiming = { phase, attempt, startedAt: new Date().toISOString(), durationMs: 0, outcome: 'failed' };
    try { const result = await action(stage); stage.outcome = 'completed'; return result; }
    finally {
      stage.durationMs = elapsed(start);
      timings.stages.push(stage);
      timings.durationMs = elapsed(started);
      writeJson(path.join(folder, 'sketch-timing.json'), timings);
    }
  };
  let nativeSessionId: string | undefined;
  let extraction: SketchExtraction | undefined;
  let report: SketchReport = { source, revisionId, status: 'rejected', geometryValid: false, calibrated: false,
    metersPerPixel: 1, issues: [], adjustments: [], mapping: {}, timings };
  const image = (file: string): NonNullable<ChatTurnInput['images']>[number] => ({ path: file, mimeType: 'image/png', width: source.width, height: source.height });
  const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
  const run = async (systemPrompt: string, message: string, imagePhase: NonNullable<ChatTurnInput['imagePhase']>, attempt: number) => timed(imagePhase === 'extract' ? 'recognize' : 'patch', attempt, async (stage) => {
    if (signal?.aborted) throw new Error('草图还原已取消');
    let failed = false;
    let turnText = '';
    const result = await adapter.run({ cwd, systemPrompt, message, nativeSessionId, model: input.model, images: [image(source.imagePath)], imagePhase }, (event) => {
      if (event.type === 'error') failed = true;
      if (event.type === 'text' && turnText.length < 1_000_000) turnText += event.text;
      emit(event);
    }, signal);
    stage.provider = result.timings;
    nativeSessionId = result.nativeSessionId ?? nativeSessionId;
    if (/\[\s*Unsupported Image\s*\]|does not support (?:image|vision)|images? (?:are |is )?not supported/i.test(turnText)) {
      throw new UnsupportedSketchImageError('当前模型或 API 代理未接收图片（Unsupported Image）。请切换支持图片的模型，或检查代理是否转发图像内容；本次不会按文字猜测户型。');
    }
    if (result.failed || failed || signal?.aborted) throw new Error(signal?.aborted ? '草图还原已取消' : '模型调用失败，识别草案已保留');
  });
  const persist = () => {
    // Restore server-owned canonical artifacts if an Agent edited a non-requested file.
    if (extraction) writeJson(path.join(folder, 'sketch.json'), extraction);
    saveSketchReport(cwd, report);
  };
  let correction = input.message;
  let lastAttempt = 1;
  writeJson(path.join(folder, 'validation.json'), { valid: false, status: 'pending', sketchId: source.id });
  try {
    if (input.previous?.extraction && input.previous.source.id === source.id) {
      extraction = structuredClone(input.previous.extraction);
      report = { ...structuredClone(input.previous), revisionId, status: 'needs_review', visualReview: undefined, overlayPath: undefined, confirmation: undefined, timings };
      if (report.model) report.model.model.revisionId = revisionId;
      await timed('persist', 1, persist);
      await run(sketchPatchPrompt(source, revisionId, hashJson(extraction)), correction, 'patch', 1);
      extraction = await timed('parse', 1, () => applyExtractionPatch(extraction!, read('sketch-patch.json'), source, hashJson(extraction)));
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      lastAttempt = attempt + 1;
      try {
        if (!extraction) {
          emit({ type: 'progress', message: `正在识别墙线、门窗和文字（${attempt + 1}/3）…` });
          await run(sketchExtractionPrompt(source, revisionId), correction, 'extract', attempt + 1);
          extraction = await timed('parse', attempt + 1, () => parseExtraction(read('sketch.json'), source));
          writeJson(path.join(folder, 'sketch-raw.json'), extraction);
        } else if (attempt > 0) {
          emit({ type: 'progress', message: `正在按对象修正识别结果（${attempt + 1}/3）…` });
          await timed('persist', attempt + 1, persist);
          // Remove only this turn's transient patch, so an omitted deliverable cannot replay an old patch.
          fs.rmSync(path.join(folder, 'sketch-patch.json'), { force: true });
          await run(sketchPatchPrompt(source, revisionId, hashJson(extraction)), correction, 'patch', attempt + 1);
          extraction = await timed('parse', attempt + 1, () => applyExtractionPatch(extraction!, read('sketch-patch.json'), source, hashJson(extraction)));
        }
        emit({ type: 'progress', message: '正在连接墙线、定位门窗并构建功能区…' });
        const compiled = await timed('compile', attempt + 1, () => compileSketch(extraction!, source, revisionId));
        const extractionHash = hashJson(extraction);
        report = { source, revisionId, status: 'needs_review', geometryValid: !!compiled.model && !compiled.issues.some((i) => i.severity === 'error'),
          calibrated: compiled.calibrated, metersPerPixel: compiled.metersPerPixel, extractionHash,
          extraction, issues: compiled.issues, adjustments: compiled.adjustments, mapping: compiled.mapping, model: compiled.model, timings };
        if (report.model) report.model.model.parentRevisionId = input.previous?.revisionId ?? null;
        if (report.geometryValid) {
          report.status = resolveGeometryValidStatus(report.issues.some((i) => i.severity !== 'info'));
          break;
        }
        correction = `仅修正以下有证据的几何错误，保持其他对象：\n${report.issues.filter((i) => i.severity === 'error').map((i) => `${i.objectId ?? i.id}: ${i.message}`).join('\n')}`;
      } catch (error) {
        if (signal?.aborted || error instanceof UnsupportedSketchImageError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        correction = `上一轮失败：${message}。请修正目标文件的格式或相关对象，保留不确定信息。`;
        if (attempt === 2) {
          report.status = report.geometryValid ? resolveGeometryValidStatus(true) : 'rejected';
          report.issues.push({ id: 'pipeline-error', severity: 'error', message });
        }
      }
    }
    if (!report.geometryValid) report.status = 'rejected';
  } catch (error) {
    report.status = 'rejected';
    report.issues.push({ id: 'run-error', severity: 'error', message: error instanceof Error ? error.message : String(error) });
  }
  // Cheap local overlay for optional manual inspection; never send it back to a model.
  if (report.model) {
    try { report.overlayPath = await timed('overlay', lastAttempt, () => renderSketchOverlay(cwd, report)); }
    catch { emit({ type: 'progress', message: '辅助叠加图生成失败，仍可查看平面和识别结果' }); }
  }
  await timed('persist', lastAttempt, persist);
  timings.completedAt = new Date().toISOString();
  timings.durationMs = elapsed(started);
  writeJson(path.join(folder, 'sketch-timing.json'), timings);
  writeJson(path.join(folder, 'sketch-report.json'), report);
  emit({ type: 'sketchReview', revisionId, status: report.status });
  emit({ type: 'design', revisionId, valid: sketchValidationValid(report),
    errors: report.issues.filter((i) => i.severity === 'error').map((i) => i.message),
    warnings: report.issues.filter((i) => i.severity === 'review').map((i) => i.message) });
  if (SKETCH_HUMAN_REVIEW_ENABLED && report.status === 'needs_review') {
    emit({ type: 'progress', message: '草图已还原为待确认草案，可在「识别结果」中补充尺寸或修正标记' });
  }
  emit({ type: 'progress', message: `草图处理完成，用时 ${(timings.durationMs / 1000).toFixed(1)} 秒，模型调用 ${timings.stages.filter((s) => s.phase === 'recognize' || s.phase === 'patch').length} 次` });
  return { nativeSessionId, failed: report.status === 'rejected' || signal?.aborted === true };
}
