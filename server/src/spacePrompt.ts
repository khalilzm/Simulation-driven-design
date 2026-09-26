import type { SpaceModel } from '@sdd/shared';
import { closePolygon, outlineBBox, pointAlongWallPolyline } from './model/geometry';
import { createRegionCatalog, regionSummaries, type RegionCatalog } from './design/layoutRegions';

export interface OutlineContext {
  source: 'parent' | 'dxf' | 'none';
  outline?: string;
  currentModel?: SpaceModel;
  requireFullCoverage?: boolean;
  regions?: RegionCatalog;
}

export function outlineToText(model: SpaceModel): string {
  return JSON.stringify({ boundary: closePolygon(model.floor.boundary, 0), origin: model.model.origin,
    units: model.model.units, parentRevisionId: model.model.revisionId, bbox: outlineBBox(model.floor.boundary) });
}

export function buildOutlineJson(outline: {
  boundary: SpaceModel['floor']['boundary']; origin: SpaceModel['model']['origin'];
  bbox: { width: number; height: number; area: number };
}): string {
  return JSON.stringify({ ...outline, boundary: closePolygon(outline.boundary, 0) });
}

/** Agent 只分配合法区域；固定轮廓、空间几何、配色和墙体由服务端编译。 */
export function buildSpacePrompt(revisionId: string, ctx?: OutlineContext): string {
  if (!ctx?.outline) return '当前没有可用轮廓，不能生成布局。说明轮廓缺失或解析失败，请用户提供有效 DXF。可以讨论需求，本轮不要写布局文件或假设轮廓。';
  const catalog = ctx.regions ?? createRegionCatalog(ctx.outline, ctx.currentModel);
  const parent = catalog.parent;
  const doorIds = new Set(parent?.doors.map((door) => door.openingId) ?? []);
  const knownDoors = parent?.openings.filter((opening) => doorIds.has(opening.id)).map((opening) => ({
    id: opening.id, position: pointAlongWallPolyline(parent.walls.find((wall) => wall.id === opening.hostWallId)?.geometry.points ?? [], opening.position),
  }));
  const lockedWalls = parent?.walls.filter((wall) => wall.fixed || parent.openings.some((opening) => opening.hostWallId === wall.id))
    .map((wall) => ({ id: wall.id, points: wall.geometry.points }));
  return `在给定可用区域内，按用户需求安排一个功能分区草案。优先满足功能完整、面积合适。只讨论问题时直接回答。

可用区域已由程序计算，全部位于真实轮廓内。坐标单位 ${catalog.units}，area/targetArea/minArea 均为平方米；rect=[xmin,ymin,xmax,ymax]，boundary 是真实形状，adjacentIds 表示共享边。
${JSON.stringify(regionSummaries(catalog))}
${parent ? `\n当前分配（修改保留未涉及的功能及 ID）：\n${JSON.stringify(catalog.currentAllocations)}\n保留墙：${JSON.stringify(lockedWalls)}\n已有门位：${JSON.stringify(knownDoors)}\n` : ''}
规则：
- 只使用本轮区域 ID，每个区域最多分配一次；封闭房间必须连通。主要功能优先，狭长小区并入相邻功能或交通区。
- 区域太大时用 splits 按序切分：{regionId:"r1",axis:"x",ratio:0.3}，按该区域包围盒从低坐标侧切 30%，得到 r1.a、r1.b。可继续切子区域；父区域随即失效。
- 前台、有氧、力量等默认 enclosed:false；明确需要私密/隔音的房间 enclosed:true。程序按围合属性生成墙体，并保留已有门窗及宿主墙。
- ${ctx.requireFullCoverage ? '所有最终区域都须分配，交通或预留用途也需明确命名。' : '可暂留未分配区域，说明用途。'} 用户给出面积下限时填写 minArea；放不下的功能写入 unmetRequirements，不能缩成碎片凑齐。
- 未知朝向和窗位作为假设，详细使用条件留待深化。

用文件写入工具一次提交 designs/${revisionId}/layout.json（严格 JSON）：
{"splits":[],"allocations":[{"id":"zone-1","usage":"具体功能","regionIds":["r1"],"enclosed":false}],"assumptions":[],"unmetRequirements":[]}
示例仅说明字段，功能、ID 和区域由你选择；可选 targetArea/minArea，用户要求层高时可加 floorHeight（米）。不要输出空间/墙坐标或 model.json。上下文已齐全，无需读 DXF 或探索目录。
校验失败会反馈一次修正机会。提交后用 2～3 句说明功能安排、假设和未满足需求。`;
}

export function buildValidationCorrectionMessage(revisionId: string, errors: string[], currentOutput?: string): string {
  return [
    `designs/${revisionId}/layout.json 校验未通过。按错误调整区域分配或切分，重新写入同一文件的完整 JSON。`,
    '只能引用本轮区域及其合法切分结果；固定轮廓由程序保管，不要改写 model.json。',
    ...errors.map((error, i) => `${i + 1}. ${error}`),
    ...(currentOutput ? ['', '当前文件内容：', currentOutput] : []),
    '保留无关功能及 ID，简述修正。',
  ].join('\n');
}

/** @deprecated 使用 buildValidationCorrectionMessage */
export const buildGeometryCorrectionMessage = buildValidationCorrectionMessage;
