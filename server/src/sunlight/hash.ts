import { createHash } from 'node:crypto';
import type { SpaceModel } from '@sdd/shared';
import type { SunlightConfig } from '@sdd/shared';

export function computeSunlightInputHash(model: SpaceModel, config: SunlightConfig, engineVersion: string): string {
  const payload = JSON.stringify({ model, config, engineVersion });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}
