import type { SpaceModel, PedestrianConfig } from '@sdd/shared';
import { computeEngineInputHash } from '../analysis/runtime/inputHash';

export function computePedestrianInputHash(model: SpaceModel, config: PedestrianConfig, engineVersion: string, options: { strictGeometry: boolean } = { strictGeometry: false }): string {
  return computeEngineInputHash('pedestrian', model, config, engineVersion, options);
}
