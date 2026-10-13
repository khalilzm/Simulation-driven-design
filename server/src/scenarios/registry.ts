import { parseScenarioWorkspaceInputs, type AnalysisPlan, type ScenarioDefinition } from '@sdd/shared';
import { residentialScenario } from './residential';
import type { PreparedScenarioGeneration, ScenarioRuntime } from './types';

const runtimes: ReadonlyMap<string, ScenarioRuntime> = new Map([
  [residentialScenario.definition.id, residentialScenario],
]);

export function listScenarioDefinitions(): ScenarioDefinition[] {
  return [...runtimes.values()].map(runtime => structuredClone(runtime.definition));
}

export function createScenarioAnalysisPlan(raw: unknown): AnalysisPlan {
  const workspace = parseScenarioWorkspaceInputs(raw);
  const runtime = runtimes.get(workspace.scenario.id);
  if (!runtime) throw new Error('不支持的业务场景');
  if (workspace.scenario.version !== runtime.definition.version) throw new Error('场景版本不匹配，请重新加载');
  return runtime.createAnalysisPlan(workspace);
}

/** Unsupported scenes/versions must fail before any saved inputs or agent are touched. */
export function prepareScenarioGeneration(sessionId: string, raw: unknown): PreparedScenarioGeneration {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('缺少有效场景请求');
  const request = raw as { id?: unknown; version?: unknown; input?: unknown };
  const runtime = typeof request.id === 'string' ? runtimes.get(request.id) : undefined;
  if (!runtime) throw new Error('不支持的业务场景');
  if (request.version !== runtime.definition.version) throw new Error('场景版本不匹配，请重新加载');
  return runtime.prepareGeneration(sessionId, request.input);
}
