import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildEffectiveCatalog, TYPE_ID_KEY, type OptimizationTaskDraft, type OptimizationTaskInterpretation } from '@sdd/shared';
import { config, repoRoot, workspacesDir } from '../config';
import { getAdapter } from '../providers/registry';
import type { ProviderAdapter } from '../providers/types';
import { parseAutomaticOptimizationRequest } from './automatic';
import { loadOptimizationBaseline } from './run';
import { writeJson } from './store';

export function parseTaskInterpretation(raw: unknown, doorIds: string[]): OptimizationTaskInterpretation {
  const p = raw as OptimizationTaskInterpretation;
  if (!p || typeof p !== 'object' || !['ready', 'needs_input'].includes(p.status)
    || Object.keys(p).some((key) => !['status', 'summary', 'message', 'openingId', 'increaseM'].includes(key))
    || typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 2000
    || typeof p.message !== 'string' || !p.message.trim() || p.message.length > 4000
    || typeof p.openingId !== 'string' || (p.openingId !== '' && !doorIds.includes(p.openingId))
    || !Number.isFinite(p.increaseM) || p.increaseM < 0.02 || p.increaseM > 0.6) throw new Error('助手未返回有效任务卡，请重新描述或直接填写任务');
  return p;
}

export async function interpretOptimizationTask(raw: unknown, signal: AbortSignal, adapter?: ProviderAdapter): Promise<OptimizationTaskInterpretation> {
  const base = parseAutomaticOptimizationRequest(raw);
  const value = raw as { message: string; current: OptimizationTaskDraft };
  if (typeof value.message !== 'string' || !value.message.trim() || value.message.length > 4000
    || !value.current || typeof value.current.message !== 'string' || value.current.message.length > 4000) throw new Error('请填写本轮改造要求');
  const model = loadOptimizationBaseline(base);
  const catalog = buildEffectiveCatalog(model.componentTypes ?? []);
  const doors = model.openings.filter((o) => model.doors.some((d) => d.openingId === o.id)).filter((o) => {
    const wall = model.walls.find((w) => w.id === o.hostWallId);
    const typeId = wall?.analysisProperties?.[TYPE_ID_KEY];
    return wall && !wall.fixed && wall.role !== 'structural' && wall.role !== 'curtain' && wall.geometry.points.length === 2
      && !(typeof typeId === 'string' && catalog.get(typeId)?.role === 'structural');
  }).map(({ id, hostWallId, width }) => ({ id, hostWallId, width }));
  const current = parseTaskInterpretation({ ...value.current, status: 'ready', summary: '当前任务' }, doors.map((door) => door.id));
  const cwd = path.join(workspacesDir, base.sessionId, 'task-intakes', randomUUID());
  const context = { message: value.message, current, doors };
  writeJson(path.join(cwd, 'input.json'), context);
  const systemPrompt = fs.readFileSync(path.join(repoRoot, 'agent/prompts/optimization-task.md'), 'utf8');
  let providerError: string | undefined;
  const result = await (adapter ?? getAdapter(base.provider)).run({ cwd, systemPrompt, message: JSON.stringify(context), model: config.model || undefined },
    (event) => { if (event.type === 'error') providerError = event.message; }, signal);
  signal.throwIfAborted();
  if (result.failed || providerError) throw new Error(providerError ?? '助手整理需求失败，请重试');
  return parseTaskInterpretation(JSON.parse(fs.readFileSync(path.join(cwd, 'task.json'), 'utf8')), doors.map((door) => door.id));
}
