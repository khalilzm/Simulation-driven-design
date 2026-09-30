// 轻量空间模型 model.json 的类型契约（对齐 docs/architecture.md §6）

import type { ComponentType } from './catalog';

export const MODEL_SCHEMA_VERSION = '1';

/** 二维平面点，本地米制坐标 */
export type Vec2 = [number, number];

export type Unit = 'm' | 'mm';

export interface ModelMeta {
  schemaVersion: string;
  revisionId: string;
  parentRevisionId: string | null;
  units: Unit;
  origin: Vec2;
  sketchId?: string;
  /** Prevent uncalibrated/unreviewed reconstructions from entering analysis. */
  sketchStatus?: 'accepted' | 'needs_review' | 'rejected';
}

export interface Floor {
  boundary: Vec2[];
  elevation: number;
  height: number;
  topObstruction: boolean;
  bottomObstruction: boolean;
}

/** Agent 在本方案中定义的功能区类型（颜色与标签由 Agent 按场景生成） */
export interface SpaceType {
  id: string;
  label: string;
  /** 填充色：#RRGGBB 或 0xRRGGBB */
  color: string;
  /** 容器级分区（如整户/整层），低透明度填充且不显示标签 */
  container?: boolean;
}

export interface Space {
  id: string;
  /** 受约束分配的逻辑空间；带孔或多连通区可保存为多个简单环。 */
  allocationId?: string;
  enclosed?: boolean;
  boundary: Vec2[];
  /** 引用 spaceTypes.id */
  typeId: string;
  /** 平面标注显示名（建议与 spaceTypes.label 一致） */
  usage: string;
  targetArea: number;
  performancePreferences: Record<string, unknown>;
}

export interface WallGeometry {
  type: 'polyline';
  points: Vec2[];
}

export interface Wall {
  id: string;
  geometry: WallGeometry;
  thickness: number;
  height: number;
  fixed: boolean;
  /** 结构角色：structural 承重墙（默认不可移动）、partition 隔墙、curtain 幕墙、unknown 未知。 */
  role?: 'structural' | 'partition' | 'curtain' | 'unknown';
  /** v2 布局生成的构件；未标记的旧构件按既有建筑保留。 */
  generatedBy?: 'layout-v2';
  /** 构件类型引用，如 wall-int-200 */
  analysisProperties?: Record<string, unknown>;
}

export interface Opening {
  id: string;
  hostWallId: string;
  /** 洞口中心距墙折线起点的弧长；与 width/height 一样使用 model.units。 */
  position: number;
  width: number;
  height: number;
  /** 洞口底部距楼面高度，使用 model.units；省略时为 0。 */
  sillHeight?: number;
  generatedBy?: 'layout-v2';
  /** 填充构件引用（door/window id） */
  fillRef?: string;
}

export interface Door {
  id: string;
  openingId: string;
  swing: 'left' | 'right' | 'none';
  /** 门扇数量：1 = 单开门，2 = 双开门（默认 1） */
  leafCount?: 1 | 2;
  hinge?: 'start' | 'end';
  /** Side of the directed host wall in model coordinates. */
  opensTo?: 'left' | 'right';
  analysisProperties: Record<string, unknown>;
}

export interface Window {
  id: string;
  openingId: string;
  analysisProperties: Record<string, unknown>;
}

export interface FixedContextItem {
  id: string;
  kind: string;
  geometry: WallGeometry;
  source?: string;
}

export interface ExternalContextItem {
  id: string;
  kind: string;
  geometry: WallGeometry;
  source?: string;
}

export interface SpaceModel {
  model: ModelMeta;
  floor: Floor;
  /** Agent 在本方案中扩展的构件类型（与内置 catalog 合并） */
  componentTypes?: ComponentType[];
  /** Agent 按场景定义的功能区类型表（颜色、标签） */
  spaceTypes?: SpaceType[];
  spaces: Space[];
  walls: Wall[];
  openings: Opening[];
  doors: Door[];
  windows: Window[];
  fixedContext: FixedContextItem[];
  externalContext: ExternalContextItem[];
}
