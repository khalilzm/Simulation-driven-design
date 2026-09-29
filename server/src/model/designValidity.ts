import type { SpaceModel } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import { normalizeAgentGeometry } from './normalizeAgent';
import { validateAgentModel } from './validateAgent';
import { validateModel, type ValidationResult } from './validate';
import { outsideArea } from '../design/regionGeometry';

/** 旧版本也需要检查，不能因为文件存在就把越界草稿当作可继承方案。 */
export function validateStoredDesign(raw: unknown): ValidationResult {
  try {
    const model = normalizeAgentGeometry(raw as SpaceModel);
    if (
      SKETCH_HUMAN_REVIEW_ENABLED &&
      model.model.sketchId &&
      model.model.sketchStatus !== 'accepted'
    ) {
      return { valid: false, errors: ['草图还原尚待确认，请先核对原图、尺寸和识别问题'] };
    }
    const errors = [...new Set([...validateAgentModel(model).errors, ...validateModel(model).errors])];
    if (!errors.length) {
      const scale = model.model.units === 'mm' ? 1000 : 1;
      for (const space of model.spaces) if (outsideArea(space.boundary, model.floor.boundary) / scale ** 2 > 1e-6) {
        errors.push(`space ${space.id} 超出固定轮廓（顶点须落在 floor.boundary 内，勿按 bbox 外扩）`);
      }
    }
    return { valid: errors.length === 0, errors };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}
