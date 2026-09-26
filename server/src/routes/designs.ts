import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { SpaceModel, StreamEvent } from '@sdd/shared';
import { config, workspacesDir } from '../config';
import { getAdapter, isValidProvider } from '../providers/registry';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { validateModel } from '../model/validate';
import { listDesigns, loadDesign, saveDesign } from '../model/store';

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

  const validation = validateModel(model);
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
  const model = normalizeAgentGeometry(loaded);
  res.json(model);
});

function buildGeneratePrompt(files: string[]): string {
  return [
    '请解析工作目录 inputs/ 下的 DXF 图纸，生成可计算的空间模型。',
    `输入文件：${files.map((f) => `inputs/${f}`).join('、')}`,
    '',
    '要求：',
    '- 读取并解析 DXF（图层、单位、闭合轮廓、墙/门窗等构件识别）。',
    '- 明确单位、边界、楼层、层高、门窗与固定构件；缺失信息不得当作已知事实，用显式假设并在模型或回复中说明。',
    '- 生成一个 schemaVersion 为 "1" 的 model.json，写入 designs/ 下一个新 revision 目录（如 designs/rev-0001/model.json）。',
    '- 模型包含 model（schemaVersion/revisionId/parentRevisionId/units/origin）、floor（boundary/elevation/height/topObstruction/bottomObstruction）、spaces、walls（含 fixed 标志）、openings、doors、windows、fixedContext、externalContext。',
    '- 房间/构件 ID 保持稳定；房间边界为有效多边形；opening 的 hostWallId 指向存在的 wall；door/window 的 openingId 指向存在的 opening。',
    '- 完成后简要说明解析结果、使用的单位与假设。',
  ].join('\n');
}

designsRouter.post('/generate', async (req, res) => {
  const body = (req.body ?? {}) as { sessionId?: unknown; provider?: unknown };
  const { sessionId, provider } = body;

  if (typeof sessionId !== 'string' || !sessionId) {
    res.status(400).json({ error: 'sessionId required' });
    return;
  }
  if (!isValidProvider(provider)) {
    res.status(400).json({ error: 'invalid provider' });
    return;
  }

  const cwd = path.join(workspacesDir, sessionId);
  const inputsDir = path.join(cwd, 'inputs');
  const files = fs.existsSync(inputsDir)
    ? fs.readdirSync(inputsDir).filter((f) => /\.dxf$/i.test(f))
    : [];
  if (files.length === 0) {
    res.status(400).json({ error: 'no DXF input uploaded' });
    return;
  }

  const before = new Set(listDesigns(sessionId).map((d) => d.revisionId));

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const emit = (e: StreamEvent) => {
    if (res.writableEnded) return;
    res.write(JSON.stringify(e) + '\n');
  };

  emit({ type: 'session', sessionId, provider });

  const adapter = getAdapter(provider);
  try {
    await adapter.run({ message: buildGeneratePrompt(files), cwd, model: config.model || undefined }, emit);
  } catch (err) {
    emit({ type: 'error', message: `CLI 启动失败: ${err instanceof Error ? err.message : String(err)}` });
    emit({ type: 'done', status: 'failed' });
    res.end();
    return;
  }

  const after = listDesigns(sessionId);
  const newRev = after.find((d) => !before.has(d.revisionId));
  if (newRev) {
    const model = loadDesign(sessionId, newRev.revisionId);
    if (model) {
      const validation = validateModel(model);
      emit({ type: 'design', revisionId: newRev.revisionId, valid: validation.valid, errors: validation.errors });
    }
  }
  emit({ type: 'done', status: 'completed' });
  res.end();
});
