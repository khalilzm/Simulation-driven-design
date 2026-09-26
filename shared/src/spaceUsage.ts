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

/** 在固定轮廓内划分空间并生成墙体中心线。 */
export function formatSpaceLayoutRulesForPrompt(): string {
  return [
    '=== 轮廓内划分空间与墙体 ===',
    '写入 floor、spaceTypes、spaces、walls；openings/doors/windows/fixedContext/externalContext 本轮可 []。',
    '1) 先划小房间，最后写开放办公等大区，避免大 polygon 一次画错。',
    '2) 优先轴对齐矩形；贴外轮廓边从 floor.boundary 逐段抄写，凹口禁止斜切。',
    '3) 需隔墙处两侧 boundary 共边重合；各 space 不重叠。',
    '4) 顶点与边须在 floor 内或贴边；targetArea 为设计目标，performancePreferences 无则 {}。',
    '5) walls 由你生成：floor 外轮廓每条边 + space 间共享边各一条中心线 polyline（共边只写一次）。',
  ].join('\n');
}

/** 墙体 JSON 契约（注入 Agent 提示词）。 */
export function formatWallLayoutRulesForPrompt(): string {
  return [
    '=== 墙体（walls）===',
    '每段墙：{ id:"wall-01", geometry:{ type:"polyline", points:[[x0,y0],[x1,y1],...] }, thickness:0.12, height:3, fixed:false }。',
    '- points 为墙中心线，顺逆时针均可；折线墙可多点。',
    '- fixed 统一 false；thickness 建议 0.12～0.2（米），height 与 floor.height 一致。',
    '- 须覆盖 floor 外轮廓全部边段，以及所有 space 分区边（void 未划区域边界也要有墙）。',
    '- 可选 analysisProperties.typeId 引用 catalog（如 wall-int-200）。',
  ].join('\n');
}

/** @deprecated 使用 formatSpaceLayoutRulesForPrompt */
export function formatSpaceFromWallsRulesForPrompt(): string {
  return formatSpaceLayoutRulesForPrompt();
}

/** Agent 全权写入 spaces 与 walls，系统不做几何后处理。 */
export function formatNoPostProcessRulesForPrompt(): string {
  return [
    '=== Agent 与系统分工（硬规则） ===',
    '你写入 designs/<revisionId>/model.json 的 spaces 与 walls 是布局事实来源。',
    '系统不会派生或修改墙体；仅做校验（轮廓内、无重叠、墙在轮廓内等），失败会反馈续跑修正。',
    '系统不会修改你写的 space.boundary 或 wall.geometry。',
  ].join('\n');
}

/** 程序几何校验规则与收到报错后的修正方式（会触发自动重试）。 */
export function formatGeometryValidationRulesForPrompt(): string {
  return [
    '程序校验：space 在轮廓内、无重叠、无自交；未闭合 boundary 系统会自动补首点。',
    '失败时按报错改对应 space，勿改 floor.boundary。',
  ].join('\n');
}

/** 空间划分与校验规则（注入 Agent 提示词）。 */
export function formatPartitionLayoutRulesForPrompt(): string {
  return [
    formatSpaceLayoutRulesForPrompt(),
    '',
    formatWallLayoutRulesForPrompt(),
    '',
    formatGeometryValidationRulesForPrompt(),
  ].join('\n');
}

/** @deprecated 使用 formatPartitionLayoutRulesForPrompt */
export function formatWallFirstLayoutRulesForPrompt(): string {
  return formatPartitionLayoutRulesForPrompt();
}

/** @deprecated 第一步不需要交通规划 */
export function formatCirculationRulesForPrompt(): string {
  return '';
}

/** @deprecated 使用 formatPartitionLayoutRulesForPrompt */
export function formatContainmentRulesForPrompt(): string {
  return formatPartitionLayoutRulesForPrompt();
}

/** 注入 Agent 系统提示词的功能区类型规则 */
export function formatSpaceUsageRulesForPrompt(): string {
  return [
    '功能区类型（在布局确定后编码）：',
    '- 在 spaceTypes 声明布局中实际使用的功能区类型：{ id, label, color, container? }',
    '  · id：英文标识，如 open-office、meeting-room、private-room、kitchen、balcony',
    '  · label：平面标注中文/本地语名称，如「开放办公」「会议室」「包厢」「后厨」',
    '  · color：填充色，#RRGGBB 或 0xRRGGBB；同 typeId 同色',
    '  · 普通功能区省略 container；本轮不额外生成与房间重叠的整层/整户容器 space',
    '- 每个 space 必须设置 typeId（引用 spaceTypes.id）与 usage（显示名，建议与对应 label 一致）',
    '- 禁止所有 space 都写「房间」；类型与颜色完全由你根据用户场景定义',
    '- 示例：',
    '  spaceTypes:[{ "id":"meeting", "label":"会议室", "color":"#E8D5B5" }]',
    '  spaces:[{ "id":"mr-1", "typeId":"meeting", "usage":"会议室", "boundary":[...] }]',
  ].join('\n');
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
