import { parseAnalysisPlan, type AnalysisPlan, type AnalysisStep } from './analysisPlan';

export interface WorkspaceInputReference { id: string; version: string }
export type WorkspaceSimulationModule = AnalysisStep & { moduleId: string; version: string };

/** Building use and physics are independent: one basemap, one demand graph, many simulation instances. */
export interface ScenarioWorkspaceInputs {
  schemaVersion: '1';
  scenario: WorkspaceInputReference;
  baseMap: WorkspaceInputReference & { kind: 'dxf' | 'map' };
  spaceGraph: WorkspaceInputReference;
  simulationModules: WorkspaceSimulationModule[];
}

export function parseScenarioWorkspaceInputs(raw: unknown): ScenarioWorkspaceInputs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作区输入必须为对象');
  const input = raw as ScenarioWorkspaceInputs;
  const validReference = (ref: WorkspaceInputReference | undefined) => !!ref && typeof ref.id === 'string'
    && !!ref.id.trim() && ref.id.length <= 200 && typeof ref.version === 'string' && !!ref.version.trim() && ref.version.length <= 100;
  if (input.schemaVersion !== '1' || !validReference(input.scenario) || !validReference(input.baseMap)
    || !['dxf','map'].includes(input.baseMap.kind) || !validReference(input.spaceGraph) || !Array.isArray(input.simulationModules)) throw new Error('底图、空间节点或场景版本无效');
  if (input.simulationModules.some(module => !module || typeof module.moduleId !== 'string'
    || typeof module.version !== 'string' || !module.version.trim() || module.version.length > 100)) throw new Error('仿真模块版本或标识无效');
  const plan = parseAnalysisPlan({ schemaVersion: '1', steps: input.simulationModules });
  return structuredClone({ ...input, simulationModules: plan.steps.map((step, i) => ({
    ...step, moduleId: input.simulationModules[i].moduleId, version: input.simulationModules[i].version,
  })) });
}

/** Explicit modules determine execution; scene defaults are not injected into a configured workspace. */
export function workspaceAnalysisPlan(input: ScenarioWorkspaceInputs): AnalysisPlan {
  const workspace = parseScenarioWorkspaceInputs(input);
  return { schemaVersion: '1', steps: workspace.simulationModules.map(({ version, ...step }) => ({ ...step, moduleVersion: version })) };
}
