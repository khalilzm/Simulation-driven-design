// 领域操作补丁：以稳定对象 ID 与有界参数表达操作，由服务器实施，不让优化流程任意重写完整模型。
// 首期实现 resizeOpening（增宽）、moveOpening（沿宿主墙移动）、offsetPartition（隔墙小位移）；swapProgram 后续加入。

import type { Vec2 } from './model';

export interface ResizeOpeningPatch {
  type: 'resizeOpening';
  openingId: string;
  /** 前置值：洞口当前宽度（米）。 */
  expectedWidthM: number;
  /** 目标宽度（米）。 */
  widthM: number;
  /** 授权上限（米）。 */
  maxWidthM: number;
}

export interface MoveOpeningPatch {
  type: 'moveOpening';
  openingId: string;
  /** 前置值：洞口中心沿宿主墙的当前弧长（米）。 */
  expectedPosition: number;
  /** 目标弧长（米）。 */
  position: number;
}

export interface OffsetPartitionPatch {
  type: 'offsetPartition';
  wallId: string;
  /** 前置值：墙两端点（米）。 */
  expectedFrom: Vec2;
  expectedTo: Vec2;
  /** 沿墙右手法向的偏移量（米），首期 |offsetM| ≤ 0.6。 */
  offsetM: number;
}

export interface SwapProgramPatch {
  type: 'swapProgram';
  /** 两个物理空间 ID（不同）。交换 usage/typeId/allocationId/performancePreferences，功能身份随交换迁移。 */
  spaceA: string;
  spaceB: string;
}

export interface ResizeWindowPatch {
  type: 'resizeWindow';
  openingId: string;
  /** 前置值：外窗当前宽度（米）。 */
  expectedWidthM: number;
  /** 目标宽度（米）。 */
  widthM: number;
  /** 授权上限（米）。 */
  maxWidthM: number;
}

export interface MoveWindowPatch {
  type: 'moveWindow';
  openingId: string;
  /** 前置值：外窗中心沿宿主墙的当前弧长（米）。 */
  expectedPosition: number;
  /** 目标弧长（米）。 */
  position: number;
}

export type DesignPatch = ResizeOpeningPatch | MoveOpeningPatch | OffsetPartitionPatch | SwapProgramPatch | ResizeWindowPatch | MoveWindowPatch;
