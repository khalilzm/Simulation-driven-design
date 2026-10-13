import type { CapabilityId } from './contracts';

/** Serializable scene metadata; execution and UI components live in their respective apps. */
export interface ScenarioDefinition {
  id: string;
  version: string;
  label: string;
  inputProfileId: string;
  requirementSchemaVersion: string;
  layoutStrategyId: string;
  /** Current workflow defaults, never a capability allowlist for this building use. */
  defaultAnalysisIds: readonly CapabilityId[];
}

export const RESIDENTIAL_SCENARIO = {
  id: 'residential',
  version: '1',
  label: '住宅',
  inputProfileId: 'residential-fixed-envelope-v1',
  requirementSchemaVersion: '1',
  layoutStrategyId: 'residential-obstacle-grid-v2',
  defaultAnalysisIds: ['daylight'],
} as const satisfies ScenarioDefinition;

/** Reference to saved scene inputs. Its schema is validated by the owning runtime. */
export interface ScenarioGenerationRequest {
  id: string;
  version: string;
  input: unknown;
}
