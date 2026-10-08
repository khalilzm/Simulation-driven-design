import type { OptimizationComparison } from '@sdd/shared';
import type { ViewerContent } from '../types';
import { resolveDensityScale } from './pedestrianColor';
import { pedestrianTMax } from './pedestrianTrajectories';
import { resolveSunlightColorScale } from './sunlightColor';

/** Equal values must have equal colors in both panes; keep the saved results untouched. */
export function comparisonPresentation(data: OptimizationComparison): NonNullable<Extract<ViewerContent, { kind: 'model' }>['comparison']> {
  const sunA = resolveSunlightColorScale(data.baseline.sunlight);
  const sunB = resolveSunlightColorScale(data.candidate.sunlight);
  const pedA = resolveDensityScale(data.baseline.pedestrian);
  const pedB = resolveDensityScale(data.candidate.pedestrian);
  return {
    sunlightScale: { ...sunA, min: Math.min(sunA.min, sunB.min), max: Math.max(sunA.max, sunB.max) },
    densityScale: { ...pedA, max: Math.max(pedA.max, pedB.max) },
    pedestrianTimeMax: Math.max(pedestrianTMax(data.baseline.pedestrian), pedestrianTMax(data.candidate.pedestrian)),
  };
}
