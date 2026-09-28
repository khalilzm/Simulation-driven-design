import type { SpaceModel } from '@sdd/shared';
import { COMPONENT_CATALOG } from '@sdd/shared';
import { closePolygon, outlineBBox } from './model/geometry';
import { floorCornerVertices, floorEdgeSegments, type LayoutContext } from './design/layoutContext';
import { floorTopologyForPrompt } from './design/floorPlanTopology';
import { createLayoutContext } from './design/layoutContext';
import { PROGRAM_OUTLINE_REL } from './design/programOutline';

export interface OutlineContext {
  source: 'parent' | 'program' | 'none';
  outline?: string;
  currentModel?: SpaceModel;
  requireFullCoverage?: boolean;
  layout?: LayoutContext;
  /** 本会话 Agent 工作目录；layout 必须写在此目录下的 designs/<revisionId>/ */
  workspaceDir?: string;
  /** inputs/ 下可选参考文件（草图等），供 Agent 阅读 */
  inputHints?: string;
}

export function outlineToText(model: SpaceModel): string {
  return JSON.stringify({ boundary: closePolygon(model.floor.boundary, 0), origin: model.model.origin,
    units: model.model.units, parentRevisionId: model.model.revisionId, bbox: outlineBBox(model.floor.boundary) });
}

export function buildOutlineJson(outline: {
  boundary: SpaceModel['floor']['boundary']; origin: SpaceModel['model']['origin'];
  bbox: { width: number; height: number; area: number };
  assumptions?: string[];
}): string {
  return JSON.stringify({ ...outline, boundary: closePolygon(outline.boundary, 0) });
}

function buildDesignFromProgramPrompt(revisionId: string, ctx: OutlineContext): string {
  const hints = ctx.inputHints
    ? `用户已上传手绘草图（cwd 内 ${ctx.inputHints}）。请用 Read/图像能力阅读草图，结合自然语言推断外轮廓尺度与形状；草图不是 CAD，勿假设已有矢量轮廓。`
    : '用户未上传草图；仅根据自然语言推断合理建筑外轮廓与面积。';
  return `你是建筑方案 Design Layer：自然语言即可起方案，手绘草图可选。服务端编译几何；你不要写 model.json。

${hints}

本轮须完成两步（均写在本会话 Agent 工作目录 cwd 的相对路径）：

1) 先写 **${PROGRAM_OUTLINE_REL}**（JSON）：
   - boundary: [[x,y],…] 闭合外轮廓本地坐标（至少 3 点；可矩形、L 形等；单位米，合理估计面积）
   - origin: [0,0]
   - units: "m"
   - assumptions: 字符串数组，写明尺度/形状假设
   - 勿写 bbox（服务端会算）

2) 再写 **designs/${revisionId}/layout.json**（schemaVersion 3 拓扑引用，推荐）：
   - vertices / spaces.loop / boundaries.from-to；禁止手写 [x,y] 坐标
   - openings 优先 typeId；doors/windows 可省略 swing/尺寸由目录填充
   - 禁止 allocations、regionIds、splits、walls、model.json

禁止写入仓库根 designs/、其它 session 的 workspaces/…/designs/ 或使用指向上述的绝对路径。

${ctx.requireFullCoverage ? '布局须铺满 floor 内面积。' : '可暂留未分配面积并在 assumptions/unmetRequirements 说明。'}

提交后用 2～3 句说明轮廓假设与功能分区。`;
}

/** Agent 提交 schemaVersion 3（拓扑引用，推荐）或 2 的 layout.json；几何由服务端编译。 */
export function buildSpacePrompt(revisionId: string, ctx?: OutlineContext): string {
  if (!ctx?.outline) {
    return buildDesignFromProgramPrompt(revisionId, ctx ?? { source: 'none' });
  }
  const layout = ctx.layout ?? createLayoutContext(ctx.outline, ctx.currentModel);
  const parent = layout.parent;
  const outline = JSON.parse(ctx.outline);
  const floorBoundary = closePolygon(layout.floor.boundary, 0);
  const topology = floorTopologyForPrompt(floorBoundary);
  const corners = floorCornerVertices(floorBoundary);
  const edges = floorEdgeSegments(floorBoundary);
  const knownOpenings = parent?.openings.filter((opening) => opening.generatedBy !== 'layout-v2') ?? [];
  const lockedWalls = parent?.walls.filter((wall) => wall.fixed || knownOpenings.some((opening) => opening.hostWallId === wall.id))
    .map((wall) => ({ id: wall.id, points: wall.geometry.points }));
  const editableOpenings = parent?.openings.filter((opening) => opening.generatedBy === 'layout-v2') ?? [];
  const editableIds = new Set(editableOpenings.map((opening) => opening.id));
  const editable = {
    walls: parent?.walls.filter((wall) => wall.generatedBy === 'layout-v2' && !wall.fixed)
      .map((wall) => ({ id: wall.id, points: wall.geometry.points })),
    openings: editableOpenings,
    doors: parent?.doors.filter((door) => editableIds.has(door.openingId)),
    windows: parent?.windows.filter((window) => editableIds.has(window.openingId)),
  };
  const currentSpaces = parent?.spaces.map((space) => ({
    id: space.allocationId ?? space.id, usage: space.usage, enclosed: space.enclosed ?? false,
    boundary: space.boundary.slice(0, -1),
  }));
  const catalogOpenings = COMPONENT_CATALOG.filter((item) => item.category === 'door' || item.category === 'window')
    .map((item) => ({ id: item.id, category: item.category, defaults: item.defaults }));
  const sketchNote = ctx.inputHints
    ? `\n参考草图（inputs/）：${ctx.inputHints}。修改布局时可结合草图与用户需求；固定轮廓仍以 outline.json / 父方案为准。\n`
    : '';
  return `在固定建筑轮廓内，按用户需求设计空间与门窗。只讨论问题时直接回答。
${sketchNote}
固定轮廓拓扑（本地 ${layout.units}；**禁止手写 [x,y] 坐标**，只用 Vn / vertices / from-to 引用）：
${JSON.stringify({ origin: layout.origin, topology, boundary: outline.boundary })}

布局方式（必须遵守）：
- **推荐 schemaVersion 3**：用拓扑引用划空间，服务端展开为合法多边形；禁止 spaces[].boundary 与 boundaries[].segment 坐标。
- 角点 V0…V(n-1) 按 boundary 顶点顺序；边 E0… 连接 V_i→V_{i+1}，length 为边长。边上点：vertices[] 的 { id, edge, t }，t∈[0,1] 为沿 E_edge 起点的比例。
- 每个 space：loop 为闭合引用序列（如 ["V0","mid_s","mid_n","V3"]），顶点须沿 floor 边或内部分界，勿按 bbox 外扩。
- boundaries：{ id, from, to, kind, leftSpaceId, rightSpaceId }，from/to 为 Vn 或 vertices.id；外轮廓一侧用 outside。
- schemaVersion 2（兼容）：spaces.boundary 坐标 + boundaries.segment；仍须落在 topology 节点上。
- 禁止 allocations、regionIds、splits。墙体由程序生成；不要输出 walls/model.json。

围合与门窗：
- 共享边默认：任一侧 enclosed:true → 实体墙；两侧 open → 开放。可用 boundaries 显式 kind:"wall"|"open"。
- 外边界：boundaries 一侧 spaceId、一侧 outside，kind:wall；入口/外窗用 hostBoundaryId。
- openings 优先写 typeId（见 componentTypes），width/height 可省略由目录填充；position 为洞口中心沿宿主的弧长；落地门 sillHeight=0。
- doors 引用 openingId；可写 typeId 与 connects，swing/leafCount 可省略（由门规格默认）；swing 仅 left/right/none。
- windows 引用 openingId，可写 typeId（窗规格）。
- componentTypes（门/窗）：${JSON.stringify(catalogOpenings)}
- 封闭空间须经门或 open 边界到达开放区；有 outside 入口时全屋可达。

${parent ? `当前空间（全量提交；未改 id/boundary 须原样保留）：\n${JSON.stringify(currentSpaces)}\n保留墙：${JSON.stringify(lockedWalls)}\n保留洞口：${JSON.stringify(knownOpenings)}\n可编辑 v2 构件：${JSON.stringify(editable)}\n` : ''}
${ctx.requireFullCoverage ? '须铺满 floor 内面积（含交通/预留 space）。' : '可暂留未分配面积并说明。'} minArea、targetArea 均为参考面积（不足时写入 warnings，不导致校验失败）；无法满足的需求写入 unmetRequirements。

示例（schemaVersion 3，10×8 m 矩形；竖向分界 x=5）：
{"schemaVersion":3,"vertices":[{"id":"mid_s","edge":0,"t":0.5},{"id":"mid_n","edge":2,"t":0.5}],"spaces":[{"id":"hall","usage":"门厅","enclosed":false,"loop":["V0","mid_s","mid_n","V3"]},{"id":"studio","usage":"教室","enclosed":true,"loop":["mid_s","V1","V2","mid_n"]}],"boundaries":[{"id":"split","from":"mid_s","to":"mid_n","kind":"wall","leftSpaceId":"hall","rightSpaceId":"studio"}],"openings":[],"doors":[],"windows":[],"assumptions":[],"unmetRequirements":[]}

参考坐标（仅理解 topology，勿写入 layout）：corners=${JSON.stringify(corners)} edges=${JSON.stringify(edges.map(([a, b]) => [a, b]))}

文件路径（必须遵守）：
- 只在本会话 Agent 工作目录（cwd）内写入相对路径 designs/${revisionId}/layout.json。
- 禁止写入仓库根目录 designs/、其它 session 的 workspaces/…/designs/，或使用指向上述位置的绝对路径；否则右侧方案不会更新。

校验失败会反馈一次修正；提交后 2～3 句说明布局与假设。`;
}

export function buildValidationCorrectionMessage(revisionId: string, errors: string[], currentOutput?: string): string {
  return [
    `designs/${revisionId}/layout.json 校验未通过。使用 schemaVersion 2：spaces.boundary、boundaries.segment、openings、doors。`,
    '坐标须落在外轮廓内；封闭房间须可达；外门用 hostBoundaryId + outside。',
    'layout 必须写在本会话 cwd 下的 designs/' + revisionId + '/layout.json。',
    ...errors.map((error, i) => `${i + 1}. ${error}`),
    ...(currentOutput ? ['', '当前文件内容：', currentOutput] : []),
    '保留无关 id，简述修正。',
  ].join('\n');
}

/** @deprecated 使用 buildValidationCorrectionMessage */
export const buildGeometryCorrectionMessage = buildValidationCorrectionMessage;
