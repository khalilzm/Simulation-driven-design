import type { SpaceModel } from '@sdd/shared';
import {
  formatNoPostProcessRulesForPrompt,
  formatPartitionLayoutRulesForPrompt,
  formatSpaceUsageRulesForPrompt,
} from '@sdd/shared';
import { closePolygon, outlineBBox } from './model/geometry';

export interface OutlineContext {
  source: 'parent' | 'dxf' | 'none';
  outline?: string;
}

/** 注入 Agent 的轮廓摘要（不含外墙段，减 token） */
export function outlineToText(model: SpaceModel): string {
  const boundary = model.floor.boundary;
  return JSON.stringify({
    boundary,
    origin: model.model.origin,
    parentRevisionId: model.model.revisionId,
    bbox: outlineBBox(boundary),
  });
}

export function buildOutlineJson(outline: {
  boundary: SpaceModel['floor']['boundary'];
  origin: SpaceModel['model']['origin'];
  bbox: { width: number; height: number; area: number };
}): string {
  const boundary = closePolygon(outline.boundary, 0);
  return JSON.stringify({ ...outline, boundary });
}

export function buildSpacePrompt(revisionId: string, ctx?: OutlineContext): string {
  if (!ctx?.outline) {
    return `你服务于基于 DXF 固定轮廓生成空间的应用。当前没有可用的固定轮廓，无法生成可靠的空间模型。
请简要说明缺少可用轮廓，并请用户上传有效的 DXF 或确认轮廓输入；不能断言用户未上传文件，解析失败也可能导致轮廓缺失。
本轮不要调用文件工具或写入 designs/${revisionId}/model.json，不要自行假设矩形轮廓，不要声称已完成设计。可以回答用户的概念性问题，但不能把讨论当作已生成方案。`;
  }

  const sourceLabel = ctx.source === 'dxf' ? '从 DXF 解析并归一化的固定轮廓' : '已有方案的固定轮廓';

  return `你是基于 DXF 固定轮廓快速生成空间布局的设计 Agent。
目标文件：designs/${revisionId}/model.json。用文件写入/编辑工具一次写入完整 JSON，禁止 glob/grep/read/shell/task。

=== 轮廓（outline）===
${sourceLabel}：
${ctx.outline}

- floor.boundary / model.origin 与 outline 完全一致；保留凹口，禁止 bbox 矩形替代。
- 仅用 Write/edit/apply_patch；不探索代码库。

${formatNoPostProcessRulesForPrompt()}

${formatPartitionLayoutRulesForPrompt()}

=== 输出契约（严格 JSON，无注释）===
- model：{ schemaVersion:"1", revisionId:"${revisionId}", parentRevisionId, units:"m", origin }
- floor：{ boundary, elevation:0, height:3, topObstruction:false, bottomObstruction:false }（未指定时）
- spaceTypes、spaces、walls（见下，须完整覆盖外轮廓与分区边）
- openings、doors、windows、fixedContext、externalContext：[]（本轮可空）

${formatSpaceUsageRulesForPrompt()}

=== 效率（目标一次写入、~15s 内可见平面）===
- 禁止 read/grep/glob/shell/task；只用 Write 一次写入 model.json。
- 通常 5～8 个 space：先小房间，最后用 1 个开放区 polygon 填剩余区域（勿拆成多个碎片 open-office）。
- 轴对齐矩形优先；贴外轮廓边从 floor.boundary 逐段抄写；boundary 不写重复闭合点；坐标 3 位小数。
- 各 space 不重叠；完成后 2～3 句说明即可，不要表格与长推理。`;
}

/** 校验失败时发给 Agent（续跑会话，不再附带完整 system prompt） */
export function buildValidationCorrectionMessage(revisionId: string, errors: string[]): string {
  const lines = errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
  return [
    `designs/${revisionId}/model.json 校验未通过。只改报错涉及的字段，保存同一文件。`,
    '',
    '修正：',
    '- floor.boundary 勿动；按报错改 space.boundary 或 walls。',
    '- 缺墙：补 floor 外轮廓边与 space 共享边对应的 wall 中心线。',
    '- 穿出凹口：沿 floor.boundary 折线逐点抄写，禁止两点直线跨凹口。',
    '- 重叠：先划小房间，开放办公最后填剩余区域。',
    '',
    lines,
    '',
    '保存后 2～3 句说明改动即可。',
  ].join('\n');
}

/** @deprecated 使用 buildValidationCorrectionMessage */
export const buildGeometryCorrectionMessage = buildValidationCorrectionMessage;
