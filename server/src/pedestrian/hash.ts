import { createHash } from 'node:crypto';
import type { SpaceModel, PedestrianConfig } from '@sdd/shared';

export function computePedestrianInputHash(model: SpaceModel, config: PedestrianConfig, engineVersion: string): string {
  const payload = JSON.stringify({ model, config, engineVersion });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
