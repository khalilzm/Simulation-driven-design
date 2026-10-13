import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, parsePedestrianConfig } from '@sdd/shared';
import { workspacesDir } from '../config';
import { loadDesign, isAcceptedDesign } from '../model/store';
import { ensurePedestrianConfig } from '../pedestrian/ensureConfig';
import { checkPedestrianPython, runPedestrianAnalysis } from '../pedestrian/run';

export const pedestrianRouter = Router();

function designPaths(sessionId: string, revisionId: string) {
  const base = path.join(workspacesDir, sessionId, 'designs', revisionId);
  return {
    base,
    configPath: path.join(base, 'pedestrian.json'),
  };
}

pedestrianRouter.get('/pedestrian/check', async (_req, res) => {
  const cap = CAPABILITIES.find((c) => c.id === 'pedestrian');
  const check = await checkPedestrianPython();
  res.json({ capability: cap, python: check });
});

pedestrianRouter.post('/pedestrian/run', async (req, res) => {
  const body = (req.body ?? {}) as { sessionId?: unknown; revisionId?: unknown };
  const { sessionId, revisionId } = body;
  if (typeof sessionId !== 'string' || !sessionId) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }
  if (typeof revisionId !== 'string' || !revisionId) {
    res.status(400).json({ error: 'revisionId required' });
    return;
  }

  const cap = CAPABILITIES.find((c) => c.id === 'pedestrian');
  if (!cap?.enabled) {
    res.status(503).json({ error: 'CAPABILITY_NOT_IMPLEMENTED', capability: 'pedestrian' });
    return;
  }

  const model = loadDesign(sessionId, revisionId);
  if (!model) {
    res.status(404).json({ error: 'design not found' });
    return;
  }
  if (!isAcceptedDesign(sessionId, revisionId, model)) {
    res.status(409).json({ error: '方案未通过几何校验' });
    return;
  }

  const { configPath } = designPaths(sessionId, revisionId);
  const provision = ensurePedestrianConfig(configPath, model);
  if (provision.errors?.length) {
    res.status(500).json({ error: provision.errors.join('；') });
    return;
  }

  let configRaw: unknown;
  try {
    configRaw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    res.status(400).json({ error: 'pedestrian.json 无法解析' });
    return;
  }
  const parsedConfig = parsePedestrianConfig(configRaw);
  if (!parsedConfig.ok) {
    res.status(400).json({ error: 'pedestrian.json 校验失败', errors: parsedConfig.errors });
    return;
  }

  try {
    const out = await runPedestrianAnalysis({
      sessionId,
      revisionId,
      model,
      configRaw,
    });
    res.json({
      taskId: out.taskId,
      inputHash: out.inputHash,
      simulationDir: path.relative(path.join(workspacesDir, sessionId), out.simulationDir),
      configCreated: provision.created,
      config: parsedConfig.config,
      result: out.result,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
