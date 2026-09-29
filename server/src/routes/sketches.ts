import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import type { SketchReport } from '@sdd/shared';
import { workspacesDir } from '../config';
import { nextRevisionId } from '../model/store';
import { readSketchReport, saveSketchReport } from '../sketch/runSketchTurn';
import { compileSketch } from '../sketch/compile';
import { renderSketchOverlay } from '../sketch/overlay';
import { hashJson, writeJson } from '../sketch/store';

export const sketchesRouter = Router();
sketchesRouter.use('/sketches/:sessionId/:revisionId', (req, res, next) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(req.params.sessionId) || !/^rev-\d+$/.test(req.params.revisionId)) {
    res.status(400).json({ error: 'invalid session or revision' }); return;
  }
  next();
});

sketchesRouter.get('/sketches/:sessionId/:revisionId', (req, res) => {
  const report = readSketchReport(path.join(workspacesDir, req.params.sessionId), req.params.revisionId);
  if (!report) { res.status(404).json({ error: '草图还原记录不存在' }); return; }
  res.json(report);
});

sketchesRouter.get('/sketches/:sessionId/:revisionId/overlay', (req, res) => {
  const file = path.join(workspacesDir, req.params.sessionId, 'designs', req.params.revisionId, 'sketch-overlay.png');
  if (!fs.existsSync(file)) { res.status(404).json({ error: '叠加图尚未生成' }); return; }
  res.type('png').sendFile(file);
});

/** Human confirmation creates a new revision; the original extraction/review is immutable. */
export async function confirmSketch(cwd: string, previous: SketchReport, input: {
  extractionHash?: unknown; confirm?: unknown; wallId?: unknown; lengthM?: unknown;
}): Promise<SketchReport> {
  if (input.confirm !== true || !previous.extraction || input.extractionHash !== hashJson(previous.extraction)) throw new Error('请确认当前版本的还原结果和尺寸假设');
  const extraction = structuredClone(previous.extraction);
  if (input.wallId !== undefined || input.lengthM !== undefined) {
    const wall = extraction.walls.find((w) => w.id === input.wallId);
    if (!wall || wall.points.length !== 2 || typeof input.lengthM !== 'number' || !Number.isFinite(input.lengthM) || input.lengthM <= 0) {
      throw new Error('请选择直线墙并输入正数实长（米）');
    }
    const id = 'user-calibration';
    if ([...extraction.walls, ...extraction.openings, ...extraction.labels, ...extraction.dividers, ...extraction.uncertainties].some((o) => o.id === id)) throw new Error('校准 ID 冲突，请先修正识别结果');
    extraction.dimensions = extraction.dimensions.filter((d) => d.id !== id);
    extraction.dimensions.push({ id, points: [wall.points[0], wall.points[1]], lengthM: input.lengthM, text: `用户提供 ${input.lengthM}m` });
  }
  const revisionId = nextRevisionId(path.basename(cwd));
  const compiled = compileSketch(extraction, previous.source, revisionId);
  if (!compiled.calibrated) throw new Error('缺少实际尺寸，请选一面墙输入实长');
  const errors = compiled.issues.filter((i) => i.severity === 'error');
  if (errors.length || !compiled.model) throw new Error(errors.map((i) => i.message).join('；') || '还原结果没有可用的几何模型');
  const missing = [...extraction.walls, ...extraction.openings, ...extraction.labels].filter((o) => !compiled.mapping[o.id]?.length);
  if (missing.length) throw new Error(`以下对象尚未生成，需先修正：${missing.map((o) => o.id).join('、')}`);
  const report: SketchReport = {
    source: previous.source, revisionId, status: 'accepted', geometryValid: true, calibrated: true,
    metersPerPixel: compiled.metersPerPixel, extraction, extractionHash: hashJson(extraction), model: compiled.model,
    issues: compiled.issues.map((i) => i.severity === 'review' ? { ...i, severity: 'info', message: `用户已确认：${i.message}` } : i),
    adjustments: compiled.adjustments, mapping: compiled.mapping,
    confirmation: { at: new Date().toISOString(), parentRevisionId: previous.revisionId,
      issueIds: [...new Set([...previous.issues, ...compiled.issues].filter((i) => i.severity !== 'info').map((i) => i.id))] },
  };
  report.model!.model.parentRevisionId = previous.revisionId;
  report.overlayPath = await renderSketchOverlay(cwd, report);
  writeJson(path.join(cwd, 'designs', revisionId, 'sketch.json'), extraction);
  saveSketchReport(cwd, report);
  return report;
}

sketchesRouter.post('/sketches/:sessionId/:revisionId/confirm', async (req, res) => {
  const cwd = path.join(workspacesDir, req.params.sessionId);
  const previous = readSketchReport(cwd, req.params.revisionId);
  if (!previous) { res.status(404).json({ error: '草图还原记录不存在' }); return; }
  try { res.json(await confirmSketch(cwd, previous, req.body ?? {})); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
