import type { SpaceModel, SunlightConfig } from '@sdd/shared';
import { computeEngineInputHash } from '../analysis/runtime/inputHash';

export function computeSunlightInputHash(model: SpaceModel, config: SunlightConfig, engineVersion: string): string {
  return computeEngineInputHash('sunlight', model, config, engineVersion);
}
