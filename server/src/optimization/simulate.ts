import type { OptimizationEvaluation, OptimizationRun, SpaceModel, PedestrianConfig } from '@sdd/shared';
import type { SunlightRunOutput } from '../sunlight/run';
import type { PedestrianRunOutput } from '../pedestrian/run';
import { runAnalysisPlan, DEFAULT_ANALYSIS_ENGINES, type AnalysisEngines } from '../analysis/runtime/plan';
import { resolveOptimizationAnalysisPlan } from './analysisPlan';
import { optimizationResultIdentity } from './resultIdentity';

export type SimulationContext = Pick<OptimizationRun, 'sessionId' | 'baseRevisionId' | 'scenarioHash' | 'configs' | 'analysisPlan'>;
export type EvaluateModel = (model: SpaceModel, run: SimulationContext, signal: AbortSignal,
  progress: (message: string) => void) => Promise<OptimizationEvaluation>;

function validateSunlight(sunlight: SunlightRunOutput, model: SpaceModel) {
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
}
function validatePedestrian(pedestrian: PedestrianRunOutput, config: PedestrianConfig) {
  const expected = config.agents.reduce((n, load) => n + load.count, 0);
  const metrics = pedestrian.result.metrics;
  if (pedestrian.result.status !== 'completed' || !metrics || metrics.totalAgents !== expected
    || (metrics.egressTimeSec !== null && (!Number.isFinite(metrics.egressTimeSec) || metrics.egressTimeSec <= 0))) {
    throw new Error(pedestrian.result.error ?? '疏散结果缺失、人数不一致或数值无效');
  }
}

/** A comparison policy consumes a plan; physics execution is delegated to the common runner. */
export function createModelEvaluator(engines: AnalysisEngines = DEFAULT_ANALYSIS_ENGINES): EvaluateModel {
  return async (model, run, signal, progress) => {
    const plan = resolveOptimizationAnalysisPlan(run);
    const output = await runAnalysisPlan({ sessionId: run.sessionId, revisionId: run.baseRevisionId,
      model, plan, signal, progress, validate: { sunlight: validateSunlight, pedestrian: validatePedestrian } }, engines);
    const sunlight = output.results.sunlight, pedestrian = output.results.pedestrian;
    if (!sunlight || !pedestrian) throw new Error('优化比较所需分析结果不完整');
    return { identity: optimizationResultIdentity(model, run), scenarioHash: run.scenarioHash,
      sunlight: { taskId: sunlight.taskId, inputHash: sunlight.inputHash, engineVersion: sunlight.result.engineVersion,
        spaces: sunlight.result.spaces, allocations: sunlight.result.allocations, targetAreaRatio: sunlight.result.metrics.targetAreaRatio },
      pedestrian: { taskId: pedestrian.taskId, inputHash: pedestrian.inputHash, engineVersion: pedestrian.result.engineVersion,
        totalAgents: pedestrian.result.metrics.totalAgents, egressTimeSec: pedestrian.result.metrics.egressTimeSec } };
  };
}
export const evaluateModel: EvaluateModel = createModelEvaluator();
