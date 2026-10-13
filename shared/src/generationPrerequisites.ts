import type { ResidentialBrief } from './residentialBrief';
import { roomDaylight } from './daylight';
import type { SpaceModel } from './model';

/** Admission policy for the current residential daylight validation workflow, not a framework capability limit. */
export function generationPrerequisites(base?: SpaceModel, brief?: ResidentialBrief, version = 0, dirty = false): string[] {
  const missing: string[] = [];
  if (!base?.model.dxfSource || base.spaces.length) missing.push('导入 DXF 固定底图');
  if (!brief?.rooms.length || brief.baseRevisionId !== base?.model.revisionId) missing.push('配置空间节点图');
  if (!brief?.daylight || !brief.rooms.some(room => roomDaylight(room).enabled)) missing.push('配置至少一项仿真指标');
  if (brief && (!version || dirty)) missing.push('保存空间节点与仿真指标');
  return missing;
}
