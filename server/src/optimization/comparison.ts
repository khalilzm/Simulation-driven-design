import fs from 'node:fs';
import path from 'node:path';
import type { OptimizationAnalysisView, OptimizationComparison, OptimizationEvaluation,
  OptimizationRun, PedestrianResult, SpaceModel, SunlightResult } from '@sdd/shared';
import { workspacesDir } from '../config';
import { hashValue, loadCandidateModel, loadOptimization, optimizationDir } from './store';

function readJson(file: string) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('本轮保存的分析文件缺失或无法读取，请重新优化后查看对比'); }
}

export function loadAnalysis(run: Pick<OptimizationRun, 'sessionId' | 'baseRevisionId' | 'scenarioHash' | 'configs'>,
  evaluation: OptimizationEvaluation, model: SpaceModel): OptimizationAnalysisView {
  if (evaluation.scenarioHash !== run.scenarioHash || hashValue(run.configs) !== run.scenarioHash) {
    throw new Error('分析工况与本轮优化不一致');
  }
  const readResult = (kind: 'sunlight' | 'pedestrian') => {
    const evidence = evaluation[kind];
    if (!/^[a-f0-9-]{36}$/.test(evidence.taskId)) throw new Error('分析任务标识无效');
    const dir = path.join(workspacesDir, run.sessionId, 'simulations', evidence.taskId);
    const envelope = readJson(path.join(dir, 'envelope.json'));
    if (envelope.taskId !== evidence.taskId || envelope.sessionId !== run.sessionId
      || envelope.revisionId !== run.baseRevisionId || envelope.tool !== `${kind}.run`
      || envelope.inputHash !== evidence.inputHash || envelope.status !== 'completed'
      || hashValue(readJson(path.join(dir, 'model.frozen.json'))) !== hashValue(model)
      || hashValue(readJson(path.join(dir, `${kind}.frozen.json`))) !== hashValue(run.configs[kind])) {
      throw new Error('分析图与试算模型或工况不匹配，不能用于本轮对比');
    }
    const result = readJson(path.join(dir, 'result.json'));
    if (result.status !== 'completed' || result.engineVersion !== evidence.engineVersion) {
      throw new Error('分析结果尚未完成或引擎版本不匹配');
    }
    return result;
  };
  const sunlight = readResult('sunlight') as SunlightResult;
  const pedestrian = readResult('pedestrian') as PedestrianResult;
  if (hashValue(sunlight.spaces) !== hashValue(evaluation.sunlight.spaces)
    || sunlight.metrics.targetAreaRatio !== evaluation.sunlight.targetAreaRatio
    || pedestrian.metrics.totalAgents !== evaluation.pedestrian.totalAgents
    || pedestrian.metrics.egressTimeSec !== evaluation.pedestrian.egressTimeSec) {
    throw new Error('分析图对应的指标与已保存的优化结论不一致');
  }
  return { model, sunlight, pedestrian };
}

export function loadOptimizationComparison(sessionId: string, runId: string, candidateId: string): OptimizationComparison {
  const run = loadOptimization(sessionId, runId);
  const candidate = run.candidates.find((c) => c.id === candidateId);
  if (!run.baseline || !candidate?.evaluation) throw new Error('原方案与候选方案尚未完成分析');
  const baseModel = readJson(path.join(optimizationDir(sessionId, runId), 'baseline.json')) as SpaceModel;
  if (hashValue(baseModel) !== run.baseModelHash) throw new Error('原方案快照已变化，请重新优化');
  return { run, candidateId,
    baseline: loadAnalysis(run, run.baseline, baseModel),
    candidate: loadAnalysis(run, candidate.evaluation, loadCandidateModel(run, candidateId)) };
}

export function loadOptimizationBaselineView(sessionId: string, runId: string): OptimizationAnalysisView {
  const run = loadOptimization(sessionId, runId);
  if (!run.baseline) throw new Error('现状分析尚未完成');
  const model = readJson(path.join(optimizationDir(sessionId, runId), 'baseline.json'));
  if (hashValue(model) !== run.baseModelHash) throw new Error('原方案快照已变化');
  return loadAnalysis(run, run.baseline, model);
}
