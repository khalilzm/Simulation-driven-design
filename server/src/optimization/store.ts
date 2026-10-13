import fs from 'node:fs';
import path from 'node:path';
import { legacyStorageHash } from '../analysis/runtime/identity';
import type { OptimizationRun, SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../config';

export const liveOptimizationRuns = new Set<string>();
export const hashValue = legacyStorageHash;
export const validSessionId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
export const validRevisionId = (id: unknown): id is string => typeof id === 'string' && /^rev-\d+$/.test(id);

export function optimizationDir(sessionId: string, runId: string): string {
  if (!validSessionId(sessionId) || !/^[a-f0-9-]{36}$/.test(runId)) throw new Error('无效优化任务路径');
  return path.join(workspacesDir, sessionId, 'optimizations', runId);
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export function saveOptimization(run: OptimizationRun): void {
  run.updatedAt = new Date().toISOString();
  writeJson(path.join(optimizationDir(run.sessionId, run.id), 'run.json'), run);
}

export function loadOptimization(sessionId: string, runId: string): OptimizationRun {
  const run = JSON.parse(fs.readFileSync(path.join(optimizationDir(sessionId, runId), 'run.json'), 'utf8')) as OptimizationRun;
  if (['baseline', 'planning', 'evaluating'].includes(run.status) && !liveOptimizationRuns.has(run.id)) {
    run.status = 'interrupted';
    run.error = '任务已中断；首轮暂不自动续跑，可查看已完成结果或重新开始';
    saveOptimization(run);
  }
  return run;
}

export function loadCandidateModel(run: OptimizationRun, candidateId: string): SpaceModel {
  const candidate = run.candidates.find((c) => c.id === candidateId);
  if (!candidate?.modelHash) throw new Error('候选模型不存在');
  const model = JSON.parse(fs.readFileSync(path.join(optimizationDir(run.sessionId, run.id), `${candidate.id}.json`), 'utf8')) as SpaceModel;
  if (hashValue(model) !== candidate.modelHash) throw new Error('候选模型已变化，请重新优化');
  return model;
}
