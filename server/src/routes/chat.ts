import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { StreamEvent } from '@sdd/shared';
import { config, workspacesDir } from '../config';
import { getAdapter, isValidProvider } from '../providers/registry';
import { createSession, loadSession, saveSession } from '../sessions/store';
import { checkOutlinePreserved, listDesigns, loadDesign, nextRevisionId } from '../model/store';
import { finalizeAgentModel } from '../model/finalizeModel';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { validateAgentModel } from '../model/validateAgent';
import { validateModel } from '../model/validate';
import {
  buildValidationCorrectionMessage,
  buildOutlineJson,
  buildSpacePrompt,
  outlineToText,
  type OutlineContext,
} from '../spacePrompt';
import { extractDxfOutline } from '../dxf/outline';
import { salvageDsmlToRevision } from '../providers/dsmlSalvage';

export const chatRouter = Router();

/** 校验失败后同会话续跑修正的最大次数（不含首次生成）；0 = 单次出图，目标 ~10–15s */
const MAX_VALIDATION_CORRECTIONS = 0;

chatRouter.post('/chat', async (req, res) => {
  const body = (req.body ?? {}) as { provider?: unknown; sessionId?: unknown; message?: unknown };
  const { provider, sessionId, message } = body;

  if (!isValidProvider(provider)) {
    res.status(400).json({ error: 'invalid provider' });
    return;
  }
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  const id = typeof sessionId === 'string' && sessionId ? sessionId : randomUUID();
  let session = loadSession(id);
  if (!session) {
    session = createSession(id, provider);
  } else if (session.provider !== provider) {
    res.status(409).json({ error: 'session provider mismatch' });
    return;
  }

  const cwd = path.join(workspacesDir, id);
  fs.mkdirSync(cwd, { recursive: true });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const abort = new AbortController();
  req.on('aborted', () => abort.abort());

  let assistantText = '';
  let hadError = false;
  const emit = (e: StreamEvent) => {
    if (res.writableEnded) return;
    if (e.type === 'text') assistantText += e.text;
    if (e.type === 'error') hadError = true;
    res.write(JSON.stringify(e) + '\n');
  };

  emit({ type: 'session', sessionId: id, provider });
  session.messages.push({ role: 'user', content: message, ts: new Date().toISOString() });

  const adapter = getAdapter(provider);
  const designs = listDesigns(id);
  const before = new Set(designs.map((d) => d.revisionId));
  const latest = designs[designs.length - 1];
  const parent = latest ? loadDesign(id, latest.revisionId) : null;
  const inputsDir = path.join(cwd, 'inputs');
  const dxfFiles = fs.existsSync(inputsDir) ? fs.readdirSync(inputsDir).filter((f) => /\.dxf$/i.test(f)) : [];

  const outlineCtx: OutlineContext = (() => {
    if (parent) return { source: 'parent', outline: outlineToText(parent) };
    if (dxfFiles.length > 0) {
      try {
        const text = fs.readFileSync(path.join(inputsDir, dxfFiles[0]), 'utf8');
        const parsed = extractDxfOutline(text);
        if (parsed) {
          return {
            source: 'dxf',
            outline: buildOutlineJson(parsed),
          };
        }
      } catch {
        // 解析失败则回退到无外轮廓
      }
    }
    return { source: 'none' };
  })();
  const revisionId = nextRevisionId(id);
  fs.mkdirSync(path.join(cwd, 'designs', revisionId), { recursive: true });

  let runFailed = false;
  let nativeSessionId = session.nativeSessionId;
  let userMessage = message;
  const systemPrompt = buildSpacePrompt(revisionId, outlineCtx);

  try {
    for (let attempt = 0; attempt <= MAX_VALIDATION_CORRECTIONS; attempt++) {
      if (attempt > 0) {
        emit({
          type: 'progress',
          message: `空间校验未通过，自动请求第 ${attempt + 1} 次修正…`,
        });
      }

      const turnTextStart = assistantText.length;
      const agentStarted = Date.now();
      const result = await adapter.run(
        {
          message: userMessage,
          nativeSessionId,
          cwd,
          model: config.model || undefined,
          systemPrompt: attempt === 0 ? systemPrompt : undefined,
        },
        emit,
        abort.signal,
      );
      emit({
        type: 'progress',
        message: `Agent 完成（${Math.round((Date.now() - agentStarted) / 1000)}s）`,
      });
      if (result.nativeSessionId) nativeSessionId = result.nativeSessionId;
      if (result.failed) {
        runFailed = true;
        break;
      }
      if (hadError) break;

      const turnText = assistantText.slice(turnTextStart);
      let targetRevId = listDesigns(id).find((d) => !before.has(d.revisionId))?.revisionId;
      if (!targetRevId && turnText && salvageDsmlToRevision(turnText, cwd, revisionId)) {
        emit({ type: 'progress', message: '已从模型输出恢复方案文件' });
        targetRevId = revisionId;
      }
      if (!targetRevId && attempt > 0) {
        targetRevId = revisionId;
      }

      if (!targetRevId) break;

      const loaded = loadDesign(id, targetRevId);
      if (!loaded) break;

      const raw = normalizeAgentGeometry(loaded);
      const agentV = validateAgentModel(raw);
      const agentErrors = [...agentV.errors];
      if (parent) {
        const outlineErr = checkOutlinePreserved(parent, raw);
        if (outlineErr) agentErrors.push(outlineErr);
      }

      const canRetry = agentErrors.length > 0 && attempt < MAX_VALIDATION_CORRECTIONS;

      if (canRetry) {
        userMessage = buildValidationCorrectionMessage(targetRevId, agentErrors);
        continue;
      }

      let finalModel = raw;
      let finalErrors = agentErrors;
      if (raw.spaces.length > 0) {
        try {
          const finalizeStarted = Date.now();
          finalModel = finalizeAgentModel(raw, targetRevId, outlineCtx);
          const modelPath = path.join(cwd, 'designs', targetRevId, 'model.json');
          fs.writeFileSync(modelPath, JSON.stringify(finalModel, null, 2));
          emit({
            type: 'progress',
            message: `已保存 ${finalModel.walls.length} 段墙体（${Date.now() - finalizeStarted}ms）`,
          });
          if (agentErrors.length === 0) {
            const v = validateModel(finalModel);
            finalErrors = v.errors;
          }
        } catch (err) {
          finalErrors = [...agentErrors, err instanceof Error ? err.message : String(err)];
        }
      }

      emit({
        type: 'design',
        revisionId: targetRevId,
        valid: finalErrors.length === 0,
        errors: finalErrors,
      });
      break;
    }

    emit({ type: 'done', status: runFailed || hadError ? 'failed' : 'completed' });
  } catch (err) {
    emit({ type: 'error', message: `CLI 启动失败: ${err instanceof Error ? err.message : String(err)}` });
    emit({ type: 'done', status: 'failed' });
  }

  if (nativeSessionId) session.nativeSessionId = nativeSessionId;
  if (assistantText) {
    session.messages.push({ role: 'assistant', content: assistantText, ts: new Date().toISOString() });
  }
  session.updatedAt = new Date().toISOString();
  saveSession(session);

  res.end();
});
