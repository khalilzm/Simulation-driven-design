import type { PedestrianResult } from '@sdd/shared';
import { hoursToSunlightColor, type RgbColor, type SunlightColorScale } from './sunlightColor';

/** 密度色标：蓝(空) → 白 → 黄 → 红(拥堵)，复用 sunlightColor 的插值。 */
const DENSITY_COLORS: RgbColor[] = [
  { r: 49, g: 54, b: 149 },
  { r: 69, g: 117, b: 180 },
  { r: 116, g: 173, b: 209 },
  { r: 171, g: 217, b: 233 },
  { r: 224, g: 243, b: 248 },
  { r: 254, g: 224, b: 144 },
  { r: 253, g: 174, b: 97 },
  { r: 244, g: 109, b: 67 },
  { r: 215, g: 48, b: 39 },
];

export function resolveDensityScale(result: PedestrianResult): SunlightColorScale {
  const densities = result.densityGrid?.density ?? [];
  const dataMax = densities.length ? Math.max(...densities) : 0;
  const max = dataMax > 0 ? Math.max(dataMax, 1.5) : 3;
  return { min: 0, max, colors: DENSITY_COLORS };
}

export function densityToColor(density: number, scale: SunlightColorScale): number {
  return hoursToSunlightColor(density, scale);
}

/** 轨迹时间渐变：绿(0) → 黄(0.5) → 红(1) */
export function trajectoryTimeColor(tNorm: number): number {
  const t = Math.max(0, Math.min(1, tNorm));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.5) {
    const u = t / 0.5;
    r = Math.round(30 + (255 - 30) * u);
    g = Math.round(200 + (220 - 200) * u);
    b = Math.round(30 * (1 - u));
  } else {
    const u = (t - 0.5) / 0.5;
    r = 255;
    g = Math.round(220 * (1 - u));
    b = Math.round(40 * u);
  }
  return (r << 16) | (g << 8) | b;
}
