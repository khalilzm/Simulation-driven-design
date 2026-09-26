import type { Space, SpaceType } from './model';

export const SPACE_TYPE_ID_KEY = 'typeId';

const GENERIC_USAGES = new Set(['房间', '未命名', 'room', 'space', 'area', '未定义']);

const FALLBACK_PALETTE = [
  0xffe4a8,
  0xa8c8f0,
  0xffb878,
  0x98d4b8,
  0x88c8e8,
  0xffd0a0,
  0xc8b8e8,
];

function darken(hex: number, factor = 0.55): number {
  const r = Math.round(((hex >> 16) & 0xff) * factor);
  const g = Math.round(((hex >> 8) & 0xff) * factor);
  const b = Math.round((hex & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** 解析 Agent 提供的颜色：#RGB、#RRGGBB、0xRRGGBB */
export function parseSpaceColor(input: unknown): number | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{6}$/.test(s)) return Number(s);
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return Number(`0x${s.slice(1)}`);
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const h = s.slice(1);
    return Number(`0x${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`);
  }
  return null;
}

export function parseSpaceType(raw: unknown): SpaceType | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id.trim()) return null;
  if (typeof o.label !== 'string' || !o.label.trim()) return null;
  if (parseSpaceColor(o.color) === null) return null;
  return {
    id: o.id.trim(),
    label: o.label.trim(),
    color: String(o.color).trim(),
    container: o.container === true,
  };
}

export function validateSpaceTypeDefinition(type: SpaceType, context: string): string[] {
  const errors: string[] = [];
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(type.id)) {
    errors.push(`${context} id 格式无效（字母开头，仅含字母数字_-）`);
  }
  if (GENERIC_USAGES.has(type.label.toLowerCase())) {
    errors.push(`${context} label 不能为泛称「${type.label}」`);
  }
  if (parseSpaceColor(type.color) === null) {
    errors.push(`${context} color 须为 #RRGGBB 或 0xRRGGBB`);
  }
  return errors;
}

export function buildSpaceTypeMap(types: SpaceType[]): Map<string, SpaceType> {
  return new Map(types.map((t) => [t.id, t]));
}

function hashColor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

export interface ResolvedSpaceStyle {
  fillColor: number;
  borderColor: number;
  labelColor: string;
  fillOpacity: number;
  showLabel: boolean;
}

/** 从 spaceTypes + space 解析填充/描边/标签样式 */
export function resolveSpaceStyle(
  space: Space,
  spaceTypes: SpaceType[] | undefined,
  index = 0,
): ResolvedSpaceStyle {
  const map = buildSpaceTypeMap(spaceTypes ?? []);
  const typeId =
    typeof space.typeId === 'string'
      ? space.typeId
      : (space.performancePreferences?.[SPACE_TYPE_ID_KEY] as string | undefined);
  const type = typeId ? map.get(typeId) : undefined;
  const fillColor = type ? (parseSpaceColor(type.color) ?? hashColor(type.id)) : hashColor(space.usage || space.id);
  const container = type?.container === true;
  return {
    fillColor,
    borderColor: darken(fillColor, 0.5),
    labelColor: hexToCss(darken(fillColor, 0.45)),
    fillOpacity: container ? 0.08 : 0.58,
    showLabel: true,
  };
}

/** 平面标签文案：usage → spaceType.label → space.id */
export function resolveSpaceLabel(
  space: Space,
  spaceTypes: SpaceType[] | undefined,
): string {
  const usage = typeof space.usage === 'string' ? space.usage.trim() : '';
  if (usage) return usage;
  const map = buildSpaceTypeMap(spaceTypes ?? []);
  const typeId =
    typeof space.typeId === 'string'
      ? space.typeId
      : (space.performancePreferences?.[SPACE_TYPE_ID_KEY] as string | undefined);
  const type = typeId ? map.get(typeId) : undefined;
  if (type?.label?.trim()) return type.label.trim();
  return space.id.trim();
}

/** 校验 space.usage；返回错误信息列表 */
export function validateSpaceUsage(usage: unknown, spaceId: string): string[] {
  if (typeof usage !== 'string' || !usage.trim()) {
    return [`space ${spaceId} 缺少 usage（功能区显示名称）`];
  }
  const trimmed = usage.trim();
  if (GENERIC_USAGES.has(trimmed.toLowerCase())) {
    return [`space ${spaceId} 的 usage 不能为泛称「${trimmed}」，须写明具体功能`];
  }
  return [];
}

/** @deprecated 使用 resolveSpaceStyle */
export function spaceUsageFillColor(usage: string, index = 0): number {
  return hashColor(usage || String(index));
}

/** @deprecated 使用 resolveSpaceStyle */
export function spaceUsageBorderColor(usage: string, index = 0): number {
  return darken(spaceUsageFillColor(usage, index), 0.5);
}

/** @deprecated 使用 resolveSpaceStyle */
export function spaceUsageLabelColor(usage: string, index = 0): string {
  return hexToCss(spaceUsageBorderColor(usage, index));
}

/** @deprecated 使用 resolveSpaceStyle */
export function spaceUsageFillOpacity(_usage: string): number {
  return 0.58;
}
