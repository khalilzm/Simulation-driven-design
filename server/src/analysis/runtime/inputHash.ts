import type { EngineCapability, SpaceModel } from '@sdd/shared';
import { canonicalHash, semanticModelHash } from './identity';

/** Algorithm flags are frozen inputs too; deadlines and process paths are operational metadata. */
export function computeEngineInputHash(capability: EngineCapability, model: SpaceModel, config: unknown,
  engineVersion: string, executionOptions: Record<string, unknown> = {}): string {
  return canonicalHash({ schemaVersion: '3', capability, modelHash: semanticModelHash(model), config, engineVersion, executionOptions });
}
