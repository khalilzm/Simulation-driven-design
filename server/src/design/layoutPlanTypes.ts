import type { Vec2 } from '@sdd/shared';

export type BoundaryKind = 'wall' | 'open';

export interface LayoutSpaceSpec {
  id: string;
  usage: string;
  enclosed: boolean;
  boundary: Vec2[];
  targetArea?: number;
  minArea?: number;
}

export interface LayoutBoundarySpec {
  id: string;
  segment: [Vec2, Vec2];
  kind: BoundaryKind;
  leftSpaceId: string;
  rightSpaceId: string;
}

export interface LayoutOpeningSpec {
  id: string;
  hostBoundaryId?: string;
  hostWallId?: string;
  /** 洞口中心距所引用墙/边界起点的弧长（model.units） */
  position: number;
  width: number;
  height: number;
  sillHeight?: number;
  /** 构件目录 id（如 door-single-900）；可省略 width/height，由服务端填充 */
  typeId?: string;
}

export interface LayoutDoorSpec {
  id: string;
  openingId: string;
  swing: 'left' | 'right' | 'none';
  leafCount?: 1 | 2;
  connects?: [string, string];
  typeId?: string;
}

export interface LayoutWindowSpec {
  id: string;
  openingId: string;
  typeId?: string;
}

export interface LayoutPlanV2 {
  schemaVersion: 2;
  spaces: LayoutSpaceSpec[];
  boundaries?: LayoutBoundarySpec[];
  openings?: LayoutOpeningSpec[];
  doors?: LayoutDoorSpec[];
  windows?: LayoutWindowSpec[];
  assumptions: string[];
  unmetRequirements: string[];
  floorHeight?: number;
  wallThickness?: number;
}

/** Agent 提交的 v3 计划；由 parseLayoutPlan 展开为 LayoutPlanV2。 */
export interface LayoutVertexRef {
  id: string;
  edge: number;
  t: number;
}

export type LayoutLoopRef = string | { corner: number } | { edge: number; t: number };

export interface LayoutPlanV3Space {
  id: string;
  usage: string;
  enclosed: boolean;
  loop: LayoutLoopRef[];
  targetArea?: number;
  minArea?: number;
}

export interface LayoutBoundarySpecV3 {
  id: string;
  from: LayoutLoopRef;
  to: LayoutLoopRef;
  kind: BoundaryKind;
  leftSpaceId: string;
  rightSpaceId: string;
}

export interface LayoutPlanV3 {
  schemaVersion: 3;
  vertices?: LayoutVertexRef[];
  spaces: LayoutPlanV3Space[];
  boundaries?: LayoutBoundarySpecV3[];
  openings?: LayoutOpeningSpec[];
  doors?: LayoutDoorSpec[];
  windows?: LayoutWindowSpec[];
  assumptions: string[];
  unmetRequirements: string[];
  floorHeight?: number;
}
