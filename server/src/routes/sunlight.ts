import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITIES, parseSunlightConfig } from '@sdd/shared';
import { workspacesDir } from '../config';
import { loadDesign, isAcceptedDesign } from '../model/store';
import { readSketchReport } from '../sketch/runSketchTurn';
import { ensureSunlightConfig } from '../sunlight/ensureConfig';
import { checkSunlightPython, runSunlightAnalysis } from '../sunlight/run';

export const sunlightRouter = Router();

function designPaths(sessionId: string, revisionId: string) {
  const base = path.join(workspacesDir, sessionId, 'designs', revisionId);
  return {
    base,
    modelPath: path.join(base, 'model.json'),
    configPath: path.join(base, 'sunlight.json'),
  };
}

sunlightRouter.get('/sunlight/check', async (_req, res) => {
  const cap = CAPABILITIES.find((c) => c.id === 'sunlight');
  const check = await checkSunlightPython();
  res.json({ capability: cap, python: check });
});

sunlightRouter.post('/sunlight/run', async (req, res) => {
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

  const sunlight = CAPABILITIES.find((c) => c.id === 'sunlight');
  if (!sunlight?.enabled) {
    res.status(503).json({ error: 'CAPABILITY_NOT_IMPLEMENTED', capability: 'sunlight' });
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

  // 草图还原的缺信息/假设以 review 警告记录在报告里；仿真阶段把它们透出，而不是在还原阶段拦截。
  const reconstructionWarnings = readSketchReport(path.join(workspacesDir, sessionId), revisionId)
    ?.issues.filter((i) => i.severity === 'review').map((i) => i.message) ?? [];

  const { modelPath, configPath } = designPaths(sessionId, revisionId);
  const provision = ensureSunlightConfig(configPath);
  if (provision.errors?.length) {
    res.status(500).json({ error: provision.errors.join('；') });
    return;
  }

  let configRaw: unknown;
  try {
    configRaw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    res.status(400).json({ error: 'sunlight.json 无法解析' });
    return;
  }
  const parsedConfig = parseSunlightConfig(configRaw);
  if (!parsedConfig.ok) {
    res.status(400).json({ error: 'sunlight.json 校验失败', errors: parsedConfig.errors });
    return;
  }

  try {
    const out = await runSunlightAnalysis({
      sessionId,
      revisionId,
      model,
      configRaw,
      modelPath,
      configPath,
    });
    res.json({
      taskId: out.taskId,
      inputHash: out.inputHash,
      simulationDir: path.relative(path.join(workspacesDir, sessionId), out.simulationDir),
      sunlightConfigCreated: provision.created,
      config: parsedConfig.config,
      result: out.result,
      reconstructionWarnings,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
