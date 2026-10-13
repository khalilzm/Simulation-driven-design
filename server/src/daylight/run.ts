import path from 'node:path';
import { parseAnalysisPlan, type DaylightConfig, type DaylightResult, type EngineTaskOutput, type SpaceModel } from '@sdd/shared';
import { config, repoRoot, sunlightProcessEnv } from '../config';
import { runEngineTask, type EngineTaskScope } from '../analysis/runtime/task';

export const DAYLIGHT_ENGINE_ID = 'radiance-indoor-daylight-factor@1';
export interface DaylightRunInput extends EngineTaskScope { model: SpaceModel; config: DaylightConfig }
export type DaylightRunOutput = EngineTaskOutput<DaylightResult>;
export async function runDaylightAnalysis(input: DaylightRunInput): Promise<DaylightRunOutput> {
  const step = parseAnalysisPlan({ schemaVersion: '1', steps: [{ capability: 'daylight', config: input.config }] }).steps[0];
  if (step.capability !== 'daylight') throw new Error('采光工况无效');
  if (step.config.sensors.referenceHeightAboveFloor >= input.model.floor.height / (input.model.model.units === 'mm' ? 1000 : 1))
    throw new Error('采光评价平面须低于室内层高');
  return runEngineTask({ ...input, config: step.config, capability: 'daylight', engineVersion: DAYLIGHT_ENGINE_ID,
    python: config.sunlightPython, script: path.join(repoRoot, 'server/python/sunlight/daylight_engine.py'), env: sunlightProcessEnv() });
}
