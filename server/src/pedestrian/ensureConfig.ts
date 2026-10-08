import fs from 'node:fs';
import path from 'node:path';
import type { SpaceModel } from '@sdd/shared';

/** 默认人员密度（人/㎡），约 1 人 / 8㎡，首次生成 pedestrian.json 时按面积折算。 */
const DEFAULT_DENSITY = 0.125;

interface DefaultPopulationOptions {
  /** Sketch zones use enclosed:false for rendering; they are not necessarily empty circulation areas. */
  includeOpenSpaces?: boolean;
}

/** 首次生成时按封闭空间面积折算默认人数；开放交通区（enclosed:false）不设疏散起点。 */
export function defaultAgents(model: SpaceModel, options: DefaultPopulationOptions = {}): { spaceId: string; count: number }[] {
  return model.spaces
    .filter((space) => options.includeOpenSpaces || space.enclosed !== false)
    .map((space) => ({ spaceId: space.id, count: Math.max(1, Math.ceil((space.targetArea ?? 0) * DEFAULT_DENSITY)) }));
}

/** 若 revision 目录无 pedestrian.json，按模型空间生成一份默认疏散配置（仅首次创建）。 */
export function ensurePedestrianConfig(configPath: string, model: SpaceModel,
  options: DefaultPopulationOptions = {}): { created: boolean; errors?: string[] } {
  if (fs.existsSync(configPath)) {
    return { created: false };
  }
  const config = {
    schemaVersion: '1',
    scenario: 'egress',
    model: 'collision-free',
    dt: 0.05,
    maxDurationSec: 300,
    seed: 1,
    agents: defaultAgents(model, options),
  };
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tmp, configPath);
  } catch (err) {
    return { created: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  return { created: true };
}
