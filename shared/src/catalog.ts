export type ComponentCategory = 'wall' | 'door' | 'window' | 'elevator' | 'stair';

export const TYPE_ID_KEY = 'typeId';
export const CUSTOM_COMPONENT_KEY = 'custom';

export interface ComponentDefaults {
  width?: number;
  height?: number;
  thickness?: number;
  leafCount?: 1 | 2;
  swing?: 'left' | 'right' | 'none';
  /** 平面占地 [宽, 深]，米 */
  footprint?: [number, number];
}

export interface ComponentType {
  id: string;
  category: ComponentCategory;
  label: string;
  defaults: ComponentDefaults;
}

export const COMPONENT_CATALOG: ComponentType[] = [
  {
    id: 'wall-int-200',
    category: 'wall',
    label: '内隔墙200',
    defaults: { thickness: 0.2, height: 3 },
  },
  {
    id: 'wall-shear-300',
    category: 'wall',
    label: '承重墙300',
    defaults: { thickness: 0.3, height: 3 },
  },
  {
    id: 'door-single-900',
    category: 'door',
    label: '单开门900',
    defaults: { width: 0.9, height: 2.1, leafCount: 1, swing: 'left' },
  },
  {
    id: 'door-double-1800',
    category: 'door',
    label: '双开入户门1800',
    defaults: { width: 1.8, height: 2.1, leafCount: 2, swing: 'right' },
  },
  {
    id: 'window-standard-1500',
    category: 'window',
    label: '标准窗1500',
    defaults: { width: 1.5, height: 1.5 },
  },
  {
    id: 'window-narrow-1200',
    category: 'window',
    label: '窄窗1200',
    defaults: { width: 1.2, height: 1.5 },
  },
  {
    id: 'elevator-passenger-2100',
    category: 'elevator',
    label: '客梯2100x1600',
    defaults: { footprint: [2.1, 1.6], height: 3 },
  },
  {
    id: 'stair-core-6x6',
    category: 'stair',
    label: '楼梯核6x6',
    defaults: { footprint: [6, 6], height: 3 },
  },
];

const CATEGORY_LABEL: Record<ComponentCategory, string> = {
  wall: '墙',
  door: '门',
  window: '窗',
  elevator: '电梯',
  stair: '楼梯',
};

const builtinById = new Map(COMPONENT_CATALOG.map((c) => [c.id, c]));

const TYPE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export const DIMENSION_LIMITS = {
  wallThickness: { min: 0.05, max: 1.0 },
  wallHeight: { min: 2.0, max: 6.0 },
  doorWidth: { min: 0.6, max: 3.0 },
  doorHeight: { min: 1.8, max: 3.0 },
  windowWidth: { min: 0.3, max: 4.0 },
  windowHeight: { min: 0.3, max: 3.0 },
} as const;

export interface EffectiveCatalog {
  get(id: string): ComponentType | undefined;
  has(id: string): boolean;
}

export function buildEffectiveCatalog(custom: ComponentType[] = []): EffectiveCatalog {
  const map = new Map<string, ComponentType>(builtinById);
  for (const item of custom) map.set(item.id, item);
  return {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
  };
}

/** @deprecated 仅查内置目录；校验/解析请用 buildEffectiveCatalog */
export function getComponentType(id: string): ComponentType | undefined {
  return builtinById.get(id);
}

/** @deprecated 仅查内置目录 */
export function isKnownTypeId(id: string): boolean {
  return builtinById.has(id);
}

function isCategory(value: unknown): value is ComponentCategory {
  return value === 'wall' || value === 'door' || value === 'window' || value === 'elevator' || value === 'stair';
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseComponentType(raw: unknown): ComponentType | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !TYPE_ID_PATTERN.test(item.id)) return null;
  if (!isCategory(item.category)) return null;
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : item.id;
  const defaultsRaw = item.defaults;
  if (!defaultsRaw || typeof defaultsRaw !== 'object') return null;
  const d = defaultsRaw as Record<string, unknown>;
  const defaults: ComponentDefaults = {};
  const width = positiveNumber(d.width);
  const height = positiveNumber(d.height);
  const thickness = positiveNumber(d.thickness);
  if (width !== undefined) defaults.width = width;
  if (height !== undefined) defaults.height = height;
  if (thickness !== undefined) defaults.thickness = thickness;
  if (d.leafCount === 1 || d.leafCount === 2) defaults.leafCount = d.leafCount;
  if (d.swing === 'left' || d.swing === 'right' || d.swing === 'none') defaults.swing = d.swing;
  if (Array.isArray(d.footprint) && d.footprint.length === 2) {
    const fw = positiveNumber(d.footprint[0]);
    const fd = positiveNumber(d.footprint[1]);
    if (fw !== undefined && fd !== undefined) defaults.footprint = [fw, fd];
  }
  return { id: item.id, category: item.category, label, defaults };
}

export function validateComponentTypeDefinition(type: ComponentType, context: string): string[] {
  const errors: string[] = [];
  if (!TYPE_ID_PATTERN.test(type.id)) {
    errors.push(`${context} id 格式应为小写字母数字连字符`);
  }
  if (builtinById.has(type.id) && context.includes('componentTypes')) {
    errors.push(`${context} id 与内置类型重复: ${type.id}`);
  }
  const { defaults, category } = type;
  if (category === 'wall') {
    if (defaults.thickness === undefined) errors.push(`${context} 墙类型需 defaults.thickness`);
    else if (
      defaults.thickness < DIMENSION_LIMITS.wallThickness.min ||
      defaults.thickness > DIMENSION_LIMITS.wallThickness.max
    ) {
      errors.push(`${context} 墙厚超出允许范围`);
    }
  }
  if (category === 'door' || category === 'window') {
    if (defaults.width === undefined) errors.push(`${context} 需 defaults.width`);
    if (defaults.height === undefined) errors.push(`${context} 需 defaults.height`);
    const wLim = category === 'door' ? DIMENSION_LIMITS.doorWidth : DIMENSION_LIMITS.windowWidth;
    const hLim = category === 'door' ? DIMENSION_LIMITS.doorHeight : DIMENSION_LIMITS.windowHeight;
    if (defaults.width !== undefined && (defaults.width < wLim.min || defaults.width > wLim.max)) {
      errors.push(`${context} 宽度超出允许范围`);
    }
    if (defaults.height !== undefined && (defaults.height < hLim.min || defaults.height > hLim.max)) {
      errors.push(`${context} 高度超出允许范围`);
    }
  }
  if (category === 'elevator' || category === 'stair') {
    if (!defaults.footprint) errors.push(`${context} 需 defaults.footprint [宽,深]`);
  }
  return errors;
}

export function validateBareWallDimensions(thickness: number, height: number, context: string): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(thickness) || thickness <= 0) {
    errors.push(`${context} 裸写墙需 thickness > 0`);
  } else if (
    thickness < DIMENSION_LIMITS.wallThickness.min ||
    thickness > DIMENSION_LIMITS.wallThickness.max
  ) {
    errors.push(`${context} 墙厚超出允许范围`);
  }
  if (!Number.isFinite(height) || height <= 0) {
    errors.push(`${context} 裸写墙需 height > 0`);
  } else if (height < DIMENSION_LIMITS.wallHeight.min || height > DIMENSION_LIMITS.wallHeight.max) {
    errors.push(`${context} 墙高超出允许范围`);
  }
  return errors;
}

export function validateBareOpeningDimensions(
  width: number,
  height: number,
  category: 'door' | 'window',
  context: string,
): string[] {
  const errors: string[] = [];
  const wLim = category === 'door' ? DIMENSION_LIMITS.doorWidth : DIMENSION_LIMITS.windowWidth;
  const hLim = category === 'door' ? DIMENSION_LIMITS.doorHeight : DIMENSION_LIMITS.windowHeight;
  if (!Number.isFinite(width) || width <= 0) errors.push(`${context} 裸写洞口需 width > 0`);
  else if (width < wLim.min || width > wLim.max) errors.push(`${context} 洞口宽度超出允许范围`);
  if (!Number.isFinite(height) || height <= 0) errors.push(`${context} 裸写洞口需 height > 0`);
  else if (height < hLim.min || height > hLim.max) errors.push(`${context} 洞口高度超出允许范围`);
  return errors;
}

/** 注入 Agent 系统提示词的构件目录摘要 */
export function formatCatalogForPrompt(): string {
  const lines = ['构件类型规则（墙/门/窗/电梯/楼梯）：'];
  lines.push('1. 优先使用内置 typeId：');
  for (const category of Object.keys(CATEGORY_LABEL) as ComponentCategory[]) {
    const items = COMPONENT_CATALOG.filter((c) => c.category === category);
    if (!items.length) continue;
    lines.push(
      `   - ${CATEGORY_LABEL[category]}：${items.map((i) => `${i.id}（${i.label}，defaults=${JSON.stringify(i.defaults)}）`).join('、')}`,
    );
  }
  lines.push(
    '2. 内置无合适规格时，在 componentTypes 声明新类型（id/category/label/defaults），再在实例中引用同一 typeId；同一规格复用同一 typeId。墙 defaults 提供 thickness+height，门窗提供 width+height，门可补 leafCount/swing，楼梯电梯提供 footprint:[宽,深]+height，尺寸单位 m。',
  );
  lines.push(
    '3. 兜底：可不写 typeId，在实例上裸写尺寸——内墙写 thickness+height；门/窗在 opening 写 width+height（analysisProperties.custom 可标 true）。',
  );
  lines.push(
    '引用：opening.fillRef 或 door/window/wall 的 analysisProperties.typeId；电梯/楼梯用 fixedContext（kind/source/geometry）。禁止引用未在内置或 componentTypes 中定义的 typeId。',
  );
  return lines.join('\n');
}
