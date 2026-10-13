import { RESIDENTIAL_SCENARIO, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import { prepareResidentialTurn } from './residential';
import type { PreparedScenarioGeneration } from './types';

/** Compatibility is explicit at the boundary, never a fallback for an unknown scenario. */
export function legacyResidentialRequest(input: unknown) {
  return { id: RESIDENTIAL_SCENARIO.id, version: RESIDENTIAL_SCENARIO.version, input };
}

export function resolveScenarioTurn(prepared?: PreparedScenarioGeneration,
  document?: ResidentialBriefDocument, base?: SpaceModel): PreparedScenarioGeneration | undefined {
  if (prepared && document) throw new Error('不能同时提交场景输入和旧住宅需求');
  if (prepared) return prepared;
  if (!document) return undefined;
  if (!base) throw new Error('住宅策略生成缺少固定底图');
  return prepareResidentialTurn(base, document);
}
