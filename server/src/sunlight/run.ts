import fs from 'node:fs';
import path from 'node:path';
import { parseSunlightConfig, type EngineTaskOutput, type SpaceModel, type SunlightResult } from '@sdd/shared';
import { config, sunlightEngineId, sunlightProcessEnv, sunlightRunnerScript } from '../config';
import { execSimulation } from '../simulation/process';
import { engineTaskDirectory, runEngineTask, type EngineTaskScope } from '../analysis/runtime/task';

export interface SunlightRunInput extends EngineTaskScope { model: SpaceModel; configRaw: unknown }
export type SunlightRunOutput = EngineTaskOutput<SunlightResult>;
export const simulationTaskDir = engineTaskDirectory;

export async function runSunlightAnalysis(input: SunlightRunInput): Promise<SunlightRunOutput> {
  const parsed = parseSunlightConfig(input.configRaw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return runEngineTask({ ...input, capability: 'sunlight', config: parsed.config, engineVersion: sunlightEngineId,
    python: config.sunlightPython, script: sunlightRunnerScript, env: sunlightProcessEnv() });
}
export async function checkSunlightPython(): Promise<{ ok: boolean; detail?: unknown; error?: string }> {
  if (!fs.existsSync(sunlightRunnerScript)) {
    return { ok: false, error: `缺少脚本 ${sunlightRunnerScript}` };
  }
  try {
    const scriptDir = path.dirname(sunlightRunnerScript);
    const env = sunlightProcessEnv();
    env.PYTHONPATH = [scriptDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const { stdout, stderr, exitCode } = await execSimulation(
      config.sunlightPython,
      [path.resolve(sunlightRunnerScript), '--check'],
      scriptDir,
      env,
    );
    if (exitCode !== 0) {
      return { ok: false, error: stderr || stdout || `exit ${exitCode}` };
    }
    return { ok: true, detail: JSON.parse(stdout) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
