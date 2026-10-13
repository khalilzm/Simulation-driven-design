import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import type { StreamEvent } from '@sdd/shared';
import { config, workspacesDir } from '../config';
import { getAdapter, isValidProvider } from '../providers/registry';
import { createSession, loadSession, saveSession } from '../sessions/store';
import { isAcceptedDesign, listDesigns, loadDesign, nextRevisionId } from '../model/store';
import { loadOutlineContext, resolveFullCoverage } from '../design/outlineContext';
import { runSpaceTurn } from '../design/runSpaceTurn';
import { loadSketch, resolveSketch } from '../sketch/store';
import { readSketchReport, runSketchTurn } from '../sketch/runSketchTurn';
import { prepareScenarioGeneration } from '../scenarios/registry';
import { legacyResidentialRequest } from '../scenarios/legacy';
import type { PreparedScenarioGeneration } from '../scenarios/types';

/** 对话和“生成方案”共享会话、轮廓准备及 Agent 执行。 */
export async function handleSpaceTurn(req: Request, res: Response, generate = false): Promise<void> {
  const { provider, sessionId, message, parentRevisionId, requireFullCoverage, mode, sketchId, residentialBrief, scenario, requirePreparedInputs } = (req.body ?? {}) as {
    provider?: unknown; sessionId?: unknown; message?: unknown;
    parentRevisionId?: unknown; requireFullCoverage?: unknown;
    mode?: unknown; sketchId?: unknown;
    residentialBrief?: unknown; requirePreparedInputs?: unknown;
    scenario?: unknown;
  };
  if (!isValidProvider(provider)) {
    res.status(400).json({ error: 'invalid provider' });
    return;
  }
  if (generate && (typeof sessionId !== 'string' || !sessionId)) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }
  if (!generate && (typeof message !== 'string' || !message.trim())) {
    res.status(400).json({ error: 'message required' });
    return;
  }
  if (parentRevisionId !== undefined && parentRevisionId !== null
    && (typeof parentRevisionId !== 'string' || !/^rev-\d+$/.test(parentRevisionId))) {
    res.status(400).json({ error: 'invalid parentRevisionId' });
    return;
  }
  const id = typeof sessionId === 'string' && sessionId ? sessionId : randomUUID();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) { res.status(400).json({ error: 'invalid sessionId' }); return; }
  if (mode !== undefined && !['sketch', 'generate', 'edit'].includes(String(mode))) { res.status(400).json({ error: 'invalid mode' }); return; }
  if (sketchId !== undefined && typeof sketchId !== 'string') { res.status(400).json({ error: 'invalid sketchId' }); return; }
  let prepared: PreparedScenarioGeneration | undefined;
  if (residentialBrief !== undefined || scenario !== undefined) {
    try {
      if (residentialBrief !== undefined && scenario !== undefined) throw new Error('不能同时提交场景输入和旧住宅需求');
      if (mode !== 'edit') throw new Error('节点图生成必须使用固定底图模式');
      prepared = prepareScenarioGeneration(id, scenario !== undefined ? scenario : legacyResidentialRequest(residentialBrief));
      if (parentRevisionId !== prepared.base.model.revisionId) throw new Error('生成所用底图与节点图不一致');
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return; }
  }
  if (requirePreparedInputs === true && mode !== 'sketch') {
    const missing = prepared ? prepared.missingInputs : ['导入底图、保存空间节点与仿真指标'];
    if (missing.length) { res.status(400).json({ error: `生成前请先${missing.join('、')}` }); return; }
  }
  const session = loadSession(id) ?? createSession(id, provider);
  if (session.provider !== provider) {
    res.status(409).json({ error: 'session provider mismatch' });
    return;
  }
  const cwd = path.join(workspacesDir, id);
  let source;
  try {
    source = mode === 'generate' || mode === 'edit'
      ? loadSketch(cwd, typeof sketchId === 'string' ? sketchId : undefined)
      : await resolveSketch(cwd, typeof sketchId === 'string' ? sketchId : undefined);
  } catch (error) {
    res.status(400).json({ error: `读取草图失败：${error instanceof Error ? error.message : String(error)}` }); return;
  }
  const sketchMode = mode === 'sketch' || (mode === undefined && !!source && !parentRevisionId);
  if (sketchMode && !source) { res.status(400).json({ error: '未找到所选草图，请重新上传或选择图片' }); return; }
  const previousSketch = sketchMode && typeof parentRevisionId === 'string' ? readSketchReport(cwd, parentRevisionId) : null;
  if (previousSketch && previousSketch.source.id !== source?.id) { res.status(409).json({ error: '草图与待修正版本不匹配' }); return; }
  if (sketchMode && parentRevisionId && !previousSketch) { res.status(409).json({ error: '所选版本不是草图还原结果' }); return; }
  const parentId = sketchMode || mode === 'generate' || parentRevisionId === null ? undefined
    : typeof parentRevisionId === 'string' ? parentRevisionId : listDesigns(id).filter((design) => design.valid).at(-1)?.revisionId;
  const parent = parentId ? loadDesign(id, parentId) : null;
  if (mode === 'edit' && !parentId) { res.status(400).json({ error: '请先选择要修改的方案' }); return; }
  if (parentId && !parent) {
    res.status(404).json({ error: 'parent revision not found' });
    return;
  }
  if (parentId && parent && !isAcceptedDesign(id, parentId, parent)) {
    res.status(409).json({ error: '所选方案未通过几何校验，请选择有效版本或重新生成' });
    return;
  }
  const outline = mode === 'generate' ? { source: 'none' as const } : loadOutlineContext(cwd, parent);
  const userMessage = prepared ? [prepared.message, typeof message === 'string' ? message : ''].filter(Boolean).join('\n\n') : typeof message === 'string' && message.trim() ? message
    : sketchMode ? '忠实还原当前草图中的墙体、门窗和原始功能标注；不重新设计。'
      : '根据对话描述生成一套可落地的户型分区（外轮廓 + 房间），面积与功能名称写在 assumptions/usage 里。';
  const previousCoverage = session.requireFullCoverage ?? session.messages
    .filter((item) => item.role === 'user')
    .reduce((required, item) => resolveFullCoverage(item.content, required), false);
  outline.requireFullCoverage = typeof requireFullCoverage === 'boolean' ? requireFullCoverage
    : resolveFullCoverage(userMessage, previousCoverage);
  session.requireFullCoverage = outline.requireFullCoverage;
  session.messages.push({ role: 'user', content: userMessage, ts: new Date().toISOString() });
  fs.mkdirSync(cwd, { recursive: true });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders?.();
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.on('aborted', onAbort);
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.on('close', onClose);
  let assistantText = '';
  const emit = (event: StreamEvent) => {
    if (res.writableEnded || res.destroyed) return;
    if (event.type === 'text') assistantText += event.text;
    res.write(JSON.stringify(event) + '\n');
  };
  emit({ type: 'session', sessionId: id, provider });
  try {
    const revisionId = nextRevisionId(id);
    const result = sketchMode && source
      ? await runSketchTurn({ cwd, revisionId, source, message: userMessage, model: config.model || undefined,
        previous: previousSketch ?? undefined }, getAdapter(provider), emit, abort.signal)
      : await runSpaceTurn({
      cwd, revisionId, sessionId: id, message: userMessage, outline,
      nativeSessionId: mode === 'generate' || prepared ? undefined : session.nativeSessionId, model: config.model || undefined, requireDesign: true,
      scenario: prepared,
    }, getAdapter(provider), emit, abort.signal);
    if (!sketchMode && result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
    emit({ type: 'done', status: result.failed ? 'failed' : 'completed' });
  } catch (error) {
    emit({ type: 'error', message: `方案处理失败: ${error instanceof Error ? error.message : String(error)}` });
    emit({ type: 'done', status: 'failed' });
  } finally {
    req.off('aborted', onAbort);
    res.off('close', onClose);
    if (assistantText) session.messages.push({ role: 'assistant', content: assistantText, ts: new Date().toISOString() });
    session.updatedAt = new Date().toISOString();
    saveSession(session);
    res.end();
  }
}
