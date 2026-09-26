import { Router } from 'express';
import type { SpaceModel } from '@sdd/shared';
import { handleSpaceTurn } from './spaceTurn';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { validateStoredDesign } from '../model/designValidity';
import { isAcceptedDesign, listDesigns, loadDesign, saveDesign } from '../model/store';

export const designsRouter = Router();

designsRouter.post('/designs', (req, res) => {
  const body = (req.body ?? {}) as {
    sessionId?: unknown;
    model?: unknown;
    parentRevisionId?: unknown;
  };
  const { sessionId, model, parentRevisionId } = body;

  if (typeof sessionId !== 'string' || !sessionId) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }

  const validation = validateStoredDesign(model);
  if (!validation.valid) {
    res.status(400).json({ valid: false, errors: validation.errors });
    return;
  }

  try {
    const pid = typeof parentRevisionId === 'string' && parentRevisionId ? parentRevisionId : undefined;
    const { revisionId } = saveDesign(sessionId, model as SpaceModel, pid);
    res.json({ valid: true, errors: [], revisionId });
  } catch (err) {
    res.status(409).json({ valid: false, errors: [err instanceof Error ? err.message : String(err)] });
  }
});

designsRouter.get('/designs/:sessionId', (req, res) => {
  res.json({ designs: listDesigns(req.params.sessionId) });
});

designsRouter.get('/designs/:sessionId/:revisionId', (req, res) => {
  const loaded = loadDesign(req.params.sessionId, req.params.revisionId);
  if (!loaded) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (!isAcceptedDesign(req.params.sessionId, req.params.revisionId, loaded)) {
    res.status(409).json({ error: '方案未通过几何校验；失败稿保存在版本目录供诊断' });
    return;
  }
  const model = normalizeAgentGeometry(loaded);
  res.json(model);
});

designsRouter.post('/generate', (req, res) => handleSpaceTurn(req, res, true));
