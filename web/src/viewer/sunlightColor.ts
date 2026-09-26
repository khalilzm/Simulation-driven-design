import type { SunlightResult } from '@sdd/shared';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Ladybug Colorset.ecotect() 默认 11 色（与 honeybee_sun._legend_dict 一致） */
const ECOTECT_FALLBACK: RgbColor[] = [
  { r: 0, g: 0, b: 255 },
  { r: 53, g: 0, b: 202 },
  { r: 107, g: 0, b: 148 },
  { r: 160, g: 0, b: 95 },
  { r: 214, g: 0, b: 41 },
  { r: 255, g: 12, b: 0 },
  { r: 255, g: 66, b: 0 },
  { r: 255, g: 119, b: 0 },
  { r: 255, g: 173, b: 0 },
  { r: 255, g: 226, b: 0 },
  { r: 255, g: 255, b: 0 },
];

export interface SunlightColorScale {
  min: number;
  max: number;
  colors: RgbColor[];
}

function parseLegendColors(raw: unknown): RgbColor[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RgbColor[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    if (
      typeof o.r === 'number' &&
      typeof o.g === 'number' &&
      typeof o.b === 'number'
    ) {
      out.push({ r: o.r, g: o.g, b: o.b });
    }
  }
  return out.length ? out : null;
}

/** 与 result.legend（Ladybug LegendParameters）一致的 0xRRGGBB 色标 */
export function resolveSunlightColorScale(result: SunlightResult): SunlightColorScale {
  const lp = result.legend?.legendParameters as Record<string, unknown> | undefined;
  const min = typeof lp?.min === 'number' && Number.isFinite(lp.min) ? lp.min : 0;
  const max = typeof lp?.max === 'number' && Number.isFinite(lp.max) && lp.max > min ? lp.max : 8;
  const colors = parseLegendColors(lp?.colors) ?? ECOTECT_FALLBACK;
  return { min, max, colors };
}

export function hoursToSunlightColor(hours: number, scale: SunlightColorScale): number {
  const { min, max, colors } = scale;
  if (max <= min || colors.length === 0) return 0x888888;
  const t = Math.max(0, Math.min(1, (hours - min) / (max - min)));
  const pos = t * (colors.length - 1);
  const i0 = Math.floor(pos);
  const i1 = Math.min(colors.length - 1, i0 + 1);
  const u = pos - i0;
  const c0 = colors[i0];
  const c1 = colors[i1];
  const r = Math.round(c0.r + (c1.r - c0.r) * u);
  const g = Math.round(c0.g + (c1.g - c0.g) * u);
  const b = Math.round(c0.b + (c1.b - c0.b) * u);
  return (r << 16) | (g << 8) | b;
}

/** @deprecated 使用 hoursToSunlightColor + resolveSunlightColorScale */
export function hoursToFillColor(hours: number, targetHours?: number): number {
  const cap = targetHours !== undefined ? Math.max(targetHours * 1.5, 2) : 8;
  return hoursToSunlightColor(hours, { min: 0, max: cap, colors: ECOTECT_FALLBACK });
}

export function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 图例刻度：0 … max，与色标上限一致 */
export function sunlightLegendTicks(scale: SunlightColorScale, count = 5): number[] {
  const { min, max } = scale;
  if (count < 2 || max <= min) return [min, max];
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(min + ((max - min) * i) / (count - 1));
  }
  return ticks;
}

/** 与 hoursToSunlightColor 相同的连续色条（供图例 CSS linear-gradient） */
export function sunlightLegendGradientCss(scale: SunlightColorScale, steps = 48): string {
  const { min, max } = scale;
  if (max <= min || steps < 2) {
    return hexToCss(hoursToSunlightColor(min, scale));
  }
  const stops: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const pct = (i / steps) * 100;
    const h = min + ((max - min) * i) / steps;
    stops.push(`${hexToCss(hoursToSunlightColor(h, scale))} ${pct.toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
