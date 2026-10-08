import type { OptimizationEvaluation, OptimizationRun, SpaceModel } from '@sdd/shared';
import { runSunlightAnalysis } from '../sunlight/run';
import { runPedestrianAnalysis } from '../pedestrian/run';

export type SimulationContext = Pick<OptimizationRun, 'sessionId' | 'baseRevisionId' | 'scenarioHash' | 'configs'>;
export type EvaluateModel = (model: SpaceModel, run: SimulationContext, signal: AbortSignal,
  progress: (message: string) => void) => Promise<OptimizationEvaluation>;

/** Adapters keep physics-specific data; only comparison summaries share a contract. */
export const evaluateModel: EvaluateModel = async (model, run, signal, progress) => {
  signal.throwIfAborted();
  progress('计算日照保护指标…');
  const sunlight = await runSunlightAnalysis({ sessionId: run.sessionId, revisionId: run.baseRevisionId,
    model, configRaw: run.configs.sunlight, signal });
  if (sunlight.result.status !== 'completed') throw new Error(sunlight.result.error ?? '日照计算失败');
  const rows = sunlight.result.spaces;
  if (rows.length !== model.spaces.length || new Set(rows.map((r) => r.spaceId)).size !== rows.length
    || model.spaces.some((s) => !rows.some((r) => r.spaceId === s.id))
    || rows.some((r) => !Number.isInteger(r.sensorCount) || r.sensorCount <= 0
      || !Number.isFinite(r.sampledArea) || r.sampledArea! <= 0
      || ![r.meanHours, r.minHours, r.maxHours].every((v) => Number.isFinite(v) && v >= 0)
      || (r.targetMetRatio !== null && (!Number.isFinite(r.targetMetRatio) || r.targetMetRatio < 0 || r.targetMetRatio > 1)))
    || sunlight.result.targets?.some((t) => t.missingSpaceIds?.length)) {
    throw new Error('日照评价空间或测点不完整，请核对目标空间并适当缩小网格间距');
  }
  signal.throwIfAborted();
  progress('计算固定人数与种子下的疏散…');
  const pedestrian = await runPedestrianAnalysis({ sessionId: run.sessionId, revisionId: run.baseRevisionId,
    model, configRaw: run.configs.pedestrian, signal, strictGeometry: true });
  const expected = run.configs.pedestrian.agents.reduce((n, load) => n + load.count, 0);
  const metrics = pedestrian.result.metrics;
  if (pedestrian.result.status !== 'completed' || !metrics || metrics.totalAgents !== expected
    || (metrics.egressTimeSec !== null && (!Number.isFinite(metrics.egressTimeSec) || metrics.egressTimeSec <= 0))) {
    throw new Error(pedestrian.result.error ?? '疏散结果缺失、人数不一致或数值无效');
  }
  return { scenarioHash: run.scenarioHash,
    sunlight: { taskId: sunlight.taskId, inputHash: sunlight.inputHash, engineVersion: sunlight.result.engineVersion,
      spaces: rows, allocations: sunlight.result.allocations, targetAreaRatio: sunlight.result.metrics.targetAreaRatio },
    pedestrian: { taskId: pedestrian.taskId, inputHash: pedestrian.inputHash, engineVersion: pedestrian.result.engineVersion,
      totalAgents: metrics.totalAgents, egressTimeSec: metrics.egressTimeSec } };
};
