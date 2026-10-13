import type { AnalysisPlan, ScenarioDefinition, ScenarioWorkspaceInputs, SpaceModel, StreamEvent } from '@sdd/shared';
import type { ProviderAdapter, TurnResult } from '../providers/types';

export interface ScenarioTurnContext {
  cwd: string;
  revisionId: string;
  sessionId?: string;
  model?: string;
}

/** Prepared data and behavior remain server-local; only the scene/input reference crosses HTTP. */
export interface PreparedScenarioGeneration {
  definition: ScenarioDefinition;
  base: SpaceModel;
  message: string;
  missingInputs: string[];
  generate(context: ScenarioTurnContext, adapter: ProviderAdapter,
    emit: (event: StreamEvent) => void, signal?: AbortSignal): Promise<TurnResult>;
}

export interface ScenarioRuntime {
  definition: ScenarioDefinition;
  createAnalysisPlan(workspace: ScenarioWorkspaceInputs): AnalysisPlan;
  prepareGeneration(sessionId: string, raw: unknown): PreparedScenarioGeneration;
}
