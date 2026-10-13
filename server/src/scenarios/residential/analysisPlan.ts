import { RESIDENTIAL_SCENARIO, workspaceAnalysisPlan, type ScenarioWorkspaceInputs, type DaylightConfig, type AnalysisPlan } from '@sdd/shared';
import { runDaylightAnalysis } from '../../daylight/run';
import { runAnalysisPlan, DEFAULT_ANALYSIS_ENGINES } from '../../analysis/runtime/plan';

/** Current indoor-daylight workflow preset; it does not limit residential physics capabilities. */
export function residentialDaylightPlan(config: DaylightConfig): AnalysisPlan {
  return { schemaVersion: '1', steps: [{ capability: 'daylight', config }] };
}

/** Explicit residential workspace modules may combine any implemented capabilities and conditions. */
export function residentialWorkspacePlan(workspace: ScenarioWorkspaceInputs): AnalysisPlan {
  if (workspace.scenario.id !== 'residential') throw new Error('住宅工作区场景不匹配');
  if (workspace.scenario.version !== RESIDENTIAL_SCENARIO.version) throw new Error('住宅场景版本不匹配');
  return workspaceAnalysisPlan(workspace);
}

export async function runResidentialDaylightPlan(input: Parameters<typeof runDaylightAnalysis>[0],
  analyze: typeof runDaylightAnalysis = runDaylightAnalysis): ReturnType<typeof runDaylightAnalysis> {
  const output = await runAnalysisPlan({ ...input, plan: residentialDaylightPlan(input.config) },
    { ...DEFAULT_ANALYSIS_ENGINES, daylight: analyze });
  if (!output.results.daylight) throw new Error('住宅分析计划缺少室内采光结果');
  return output.results.daylight;
}
