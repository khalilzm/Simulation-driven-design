import fs from 'node:fs';
import path from 'node:path';
import { workspacesDir } from '../config';
import { Router } from 'express';
import type { SpaceModel } from '@sdd/shared';
import { handleSpaceTurn } from './spaceTurn';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { validateStoredDesign } from '../model/designValidity';
import {
  isAcceptedDesign,
  listDesigns,
  loadDesign,
  saveDesign,
  loadPedestrianConfig,
  loadSunlightConfig,
  savePedestrianConfig,
  saveSunlightConfig,
  updateDesignFloor,
} from '../model/store';

export const designsRouter = Router();

designsRouter.get('/designs/:sessionId/:revisionId/residential-solver', (req,res)=>{
  const {sessionId,revisionId}=req.params;
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)||!/^rev-\d+$/.test(revisionId)){res.status(400).json({error:'求解报告版本无效'});return;}
  const file=path.join(workspacesDir,sessionId,'designs',revisionId,'solver-report.json');
  if(!fs.existsSync(file)){res.status(404).json({error:'该版本没有住宅求解报告'});return;}
  try {res.json(JSON.parse(fs.readFileSync(file,'utf8')));}catch {res.status(500).json({error:'求解报告无法读取'});}
});

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

designsRouter.get('/designs/:sessionId/:revisionId/sunlight', (req, res) => {
  const { sessionId, revisionId } = req.params;
  const loaded = loadSunlightConfig(sessionId, revisionId);
  if (loaded === null) {
    res.status(404).json({ error: 'sunlight.json 不存在' });
    return;
  }
  if (!loaded.ok) {
    res.status(400).json({ valid: false, errors: loaded.errors });
    return;
  }
  res.json({ valid: true, config: loaded.config });
});

designsRouter.put('/designs/:sessionId/:revisionId/sunlight', (req, res) => {
  const { sessionId, revisionId } = req.params;
  const result = saveSunlightConfig(sessionId, revisionId, req.body);
  if (!result.ok) {
    res.status(400).json({ valid: false, errors: result.errors });
    return;
  }
  res.json({ valid: true, errors: [] });
});

designsRouter.get('/designs/:sessionId/:revisionId/pedestrian', (req, res) => {
  const { sessionId, revisionId } = req.params;
  const loaded = loadPedestrianConfig(sessionId, revisionId);
  if (loaded === null) {
    res.status(404).json({ error: 'pedestrian.json 不存在' });
    return;
  }
  if (!loaded.ok) {
    res.status(400).json({ valid: false, errors: loaded.errors });
    return;
  }
  res.json({ valid: true, config: loaded.config });
});

designsRouter.put('/designs/:sessionId/:revisionId/pedestrian', (req, res) => {
  const { sessionId, revisionId } = req.params;
  const result = savePedestrianConfig(sessionId, revisionId, req.body);
  if (!result.ok) {
    res.status(400).json({ valid: false, errors: result.errors });
    return;
  }
  res.json({ valid: true, errors: [] });
});

designsRouter.patch('/designs/:sessionId/:revisionId/floor', (req, res) => {
  const { sessionId, revisionId } = req.params;
  const body = (req.body ?? {}) as { elevation?: unknown; height?: unknown };
  if (typeof body.elevation !== 'number') {
    res.status(400).json({ valid: false, errors: ['elevation 须为 number'] });
    return;
  }
  if (typeof body.height !== 'number') {
    res.status(400).json({ valid: false, errors: ['height 须为 number'] });
    return;
  }
  const result = updateDesignFloor(sessionId, revisionId, {
    elevation: body.elevation,
    height: body.height,
  });
  if (!result.ok) {
    res.status(400).json({ valid: false, errors: result.errors });
    return;
  }
  res.json({ valid: true, errors: [] });
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
