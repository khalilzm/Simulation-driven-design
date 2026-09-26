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

/** 对话和“生成方案”共享会话、轮廓准备及 Agent 执行。 */
export async function handleSpaceTurn(req: Request, res: Response, generate = false): Promise<void> {
  const { provider, sessionId, message, parentRevisionId, requireFullCoverage } = (req.body ?? {}) as {
    provider?: unknown; sessionId?: unknown; message?: unknown;
    parentRevisionId?: unknown; requireFullCoverage?: unknown;
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
  const session = loadSession(id) ?? createSession(id, provider);
  if (session.provider !== provider) {
    res.status(409).json({ error: 'session provider mismatch' });
    return;
  }
  const cwd = path.join(workspacesDir, id);
  const parentId = parentRevisionId === null ? undefined
    : typeof parentRevisionId === 'string' ? parentRevisionId : listDesigns(id).filter((design) => design.valid).at(-1)?.revisionId;
  const parent = parentId ? loadDesign(id, parentId) : null;
  if (parentId && !parent) {
    res.status(404).json({ error: 'parent revision not found' });
    return;
  }
  if (parentId && parent && !isAcceptedDesign(id, parentId, parent)) {
    res.status(409).json({ error: '所选方案未通过几何校验，请选择有效版本或基于 DXF 重新生成' });
    return;
  }
  const outline = loadOutlineContext(cwd, parent);
  if (generate && !outline.outline) {
    res.status(400).json({ error: '没有可用轮廓，请上传有效 DXF 或加载已有方案' });
    return;
  }
  const userMessage = typeof message === 'string' && message.trim() ? message
    : '根据给定轮廓及已有需求生成一个功能分区草案。已有布局时沿用其功能要求；用途未指定时采用明确说明的临时用途假设。';
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
    const result = await runSpaceTurn({
      cwd, revisionId: nextRevisionId(id), message: userMessage, outline,
      nativeSessionId: session.nativeSessionId, model: config.model || undefined, requireDesign: generate,
    }, getAdapter(provider), emit, abort.signal);
    if (result.nativeSessionId) session.nativeSessionId = result.nativeSessionId;
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
