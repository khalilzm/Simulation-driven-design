import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseResidentialBrief } from '@sdd/shared';
import { config, repoRoot, workspacesDir } from '../config';
import { getAdapter, isValidProvider } from '../providers/registry';
import { createSession, loadSession, saveSession } from '../sessions/store';
import { loadResidentialBrief, saveResidentialBrief } from '../scenarios/residential/residentialBrief';
import { writeJson } from '../optimization/store';
export const residentialBriefsRouter = Router();

residentialBriefsRouter.post('/residential-briefs/interpret', async (req,res) => {
  const { provider, sessionId, message, module, brief } = req.body ?? {};
  if (!isValidProvider(provider)) { res.status(400).json({ error: 'invalid provider' }); return; }
  if (typeof message !== 'string' || !message.trim() || message.length > 8000 || !['graph','metrics'].includes(module)) {
    res.status(400).json({ error: '请描述空间需求或仿真目标' }); return;
  }
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) { res.status(400).json({ error: '缺少有效会话' }); return; }
  let current;
  try { current = parseResidentialBrief(brief); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return; }
  const session = loadSession(sessionId) ?? createSession(sessionId, provider);
  if (session.provider !== provider) { res.status(409).json({ error: 'session provider mismatch' }); return; }
  const cwd = path.join(workspacesDir, sessionId, 'brief-intakes', randomUUID());
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(cwd, 'input.json'), { module, message, brief: current });
  const prompt = fs.readFileSync(path.join(repoRoot, 'agent/prompts/residential-brief.md'), 'utf8');
  let errorMessage: string | undefined;
  const result = await getAdapter(provider).run({ cwd, model: config.model || undefined, systemPrompt: prompt,
    message: JSON.stringify({ module, message, brief: current }) }, event => {
    if (event.type === 'error') errorMessage = event.message;
  });
  if (result.failed || errorMessage) { res.status(502).json({ error: errorMessage ?? 'Agent 整理需求失败，请重试' }); return; }
  try {
    const updated = parseResidentialBrief(JSON.parse(fs.readFileSync(path.join(cwd, 'residential-brief.json'),'utf8')));
    if (updated.baseRevisionId !== current.baseRevisionId) throw new Error('Agent 返回的底图版本不匹配');
    res.json({ brief: updated, summary: module === 'graph' ? '已根据描述更新空间节点与连接关系。' : '已根据描述更新仿真目标。' });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Agent 未生成有效需求文档' }); }
  finally { session.updatedAt = new Date().toISOString(); saveSession(session); }
});
residentialBriefsRouter.get('/residential-briefs/:sessionId/:revisionId', (req,res) => {
  try { res.json(loadResidentialBrief(req.params.sessionId,req.params.revisionId).document); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
residentialBriefsRouter.put('/residential-briefs/:sessionId/:revisionId', (req,res) => {
  try { res.json(saveResidentialBrief(req.params.sessionId,req.params.revisionId,req.body)); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
});
