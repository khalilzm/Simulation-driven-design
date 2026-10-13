import type { ScenarioGenerationRequest } from '@sdd/shared';

/** A scene prepares its own inputs; the workbench only dispatches this request. */
export interface PreparedScenarioGeneration {
  mode: 'generate' | 'edit';
  parentRevisionId: string | null;
  scenario: ScenarioGenerationRequest;
}
