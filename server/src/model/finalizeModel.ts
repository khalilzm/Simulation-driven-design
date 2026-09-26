import type { SpaceModel } from '@sdd/shared';
import { normalizeAgentModel } from '../providers/dsmlSalvage';
import type { OutlineContext } from '../spacePrompt';
import { normalizeAgentGeometry } from './normalizeAgent';

/** Agent 提交后：锁定轮廓、规范化几何；墙体由 Agent 写入，不做后处理 */
export function finalizeAgentModel(
  raw: unknown,
  revisionId: string,
  outlineCtx?: OutlineContext,
): SpaceModel {
  const parsed = normalizeAgentModel(raw, revisionId);
  if (!parsed) throw new Error('无法解析 Agent 输出的 model.json');
  const model = normalizeAgentGeometry(parsed);

  if (outlineCtx?.outline) {
    const parsed = JSON.parse(outlineCtx.outline) as {
      boundary?: SpaceModel['floor']['boundary'];
      origin?: SpaceModel['model']['origin'];
      parentRevisionId?: string | null;
    };
    if (parsed.boundary) model.floor.boundary = parsed.boundary;
    if (parsed.origin) model.model.origin = parsed.origin;
    if (parsed.parentRevisionId !== undefined) {
      model.model.parentRevisionId = parsed.parentRevisionId;
    }
  }

  const height = model.floor.height > 0 ? model.floor.height : 3;
  model.floor.height = height;

  return model;
}
