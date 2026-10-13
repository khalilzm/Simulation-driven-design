import type { SpaceModel, DaylightConfig } from '@sdd/shared';
import { computeEngineInputHash } from '../analysis/runtime/inputHash';

export function computeDaylightInputHash(model: SpaceModel, config: DaylightConfig, engineVersion: string): string {
  return computeEngineInputHash('daylight', model, config, engineVersion);
}
