import { parseAnalysisPlan, type AnalysisPlan, type PedestrianConfig, type SpaceModel } from '@sdd/shared';
import { runSunlightAnalysis, type SunlightRunOutput } from '../../sunlight/run';
import { runPedestrianAnalysis, type PedestrianRunOutput } from '../../pedestrian/run';
import { runDaylightAnalysis } from '../../daylight/run';

export interface AnalysisEngines {
  sunlight: typeof runSunlightAnalysis;
  pedestrian: typeof runPedestrianAnalysis;
  daylight: typeof runDaylightAnalysis;
}
export const DEFAULT_ANALYSIS_ENGINES: AnalysisEngines = {
  sunlight: runSunlightAnalysis, pedestrian: runPedestrianAnalysis, daylight: runDaylightAnalysis,
};
export interface AnalysisResults {
  sunlight?: SunlightRunOutput;
  pedestrian?: PedestrianRunOutput;
  daylight?: Awaited<ReturnType<typeof runDaylightAnalysis>>;
}
export type AnalysisArtifact = NonNullable<AnalysisResults[keyof AnalysisResults]>;

/** The scene selects steps; execution has no implicit physics calls or comparison policy. */
export async function runAnalysisPlan(input: {
  sessionId: string; revisionId: string; model: SpaceModel; plan: AnalysisPlan;
  signal?: AbortSignal; progress?: (message: string) => void;
  validate?: {
    sunlight?: (output: SunlightRunOutput, model: SpaceModel) => void;
    pedestrian?: (output: PedestrianRunOutput, config: PedestrianConfig) => void;
  };
}, engines: AnalysisEngines = DEFAULT_ANALYSIS_ENGINES): Promise<{
  plan: AnalysisPlan; results: AnalysisResults; moduleResults: Record<string, AnalysisArtifact>;
}> {
  const plan = parseAnalysisPlan(input.plan), model = structuredClone(input.model);
  input.signal?.throwIfAborted();
  const ids = new Set(model.spaces.flatMap(s => [s.id, s.allocationId ?? s.id]));
  // All configuration and model references are checked before the first expensive engine call.
  for (const step of plan.steps) {
    if (step.capability === 'pedestrian' && step.config.agents.some(a => !model.spaces.some(s => s.id === a.spaceId))) throw new Error('疏散人数引用了不存在的空间');
    if (step.capability === 'sunlight' && step.config.targets?.some(t => t.spaceIds.some(id => !ids.has(id)))) throw new Error('日照目标引用了不存在的空间');
    if (step.capability === 'daylight') {
      if (step.config.targets.some(t => !ids.has(t.roomId))) throw new Error('采光目标引用了不存在的空间');
      if (step.config.sensors.referenceHeightAboveFloor >= model.floor.height / (model.model.units === 'mm' ? 1000 : 1)) throw new Error('采光评价平面须低于室内层高');
    }
  }
  const results: AnalysisResults = {};
  const moduleResults: Record<string, AnalysisArtifact> = Object.create(null);
  const counts = new Map<string, number>();
  for (const step of plan.steps) counts.set(step.capability, (counts.get(step.capability) ?? 0) + 1);
  const context = { sessionId: input.sessionId, revisionId: input.revisionId, signal: input.signal };
  for (const step of plan.steps) {
    input.signal?.throwIfAborted();
    const moduleContext = { ...context, moduleId: step.moduleId ?? step.capability, moduleVersion: step.moduleVersion ?? '1' };
    if (step.capability === 'sunlight') {
      input.progress?.('计算日照保护指标…');
      const output = await engines.sunlight({ ...moduleContext, model: structuredClone(model), configRaw: structuredClone(step.config) });
      if (output.result.status !== 'completed') throw new Error(output.result.error ?? '日照计算失败');
      input.validate?.sunlight?.(output, model);
      moduleResults[step.moduleId ?? step.capability] = output;
      if (counts.get(step.capability) === 1) results.sunlight = output;
    } else if (step.capability === 'pedestrian') {
      input.progress?.('计算固定人数与种子下的疏散…');
      const output = await engines.pedestrian({ ...moduleContext, model: structuredClone(model), configRaw: structuredClone(step.config), strictGeometry: true });
      if (output.result.status !== 'completed') throw new Error(output.result.error ?? '疏散计算失败');
      input.validate?.pedestrian?.(output, step.config);
      moduleResults[step.moduleId ?? step.capability] = output;
      if (counts.get(step.capability) === 1) results.pedestrian = output;
    } else {
      input.progress?.('计算室内采光…');
      const output = await engines.daylight({ ...moduleContext, model: structuredClone(model), config: structuredClone(step.config) });
      if (output.result.status !== 'completed') throw new Error(output.result.error ?? '采光计算失败');
      moduleResults[step.moduleId ?? step.capability] = output;
      if (counts.get(step.capability) === 1) results.daylight = output;
    }
    input.signal?.throwIfAborted();
  }
  return { plan, results, moduleResults };
}
