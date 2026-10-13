import fs from 'node:fs';
import path from 'node:path';
import { parsePedestrianConfig, type EngineTaskOutput, type SpaceModel, type PedestrianResult } from '@sdd/shared';
import { config, pedestrianEngineId, pedestrianRunnerScript } from '../config';
import { execSimulation } from '../simulation/process';
import { engineTaskDirectory, runEngineTask, type EngineTaskScope } from '../analysis/runtime/task';

export interface PedestrianRunInput extends EngineTaskScope { model: SpaceModel; configRaw: unknown; strictGeometry?: boolean }
export type PedestrianRunOutput = EngineTaskOutput<PedestrianResult>;
export const pedestrianSimulationTaskDir = engineTaskDirectory;

export async function runPedestrianAnalysis(input: PedestrianRunInput): Promise<PedestrianRunOutput> {
  const parsed = parsePedestrianConfig(input.configRaw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  const strictGeometry = input.strictGeometry ?? false;
  return runEngineTask({ ...input, capability: 'pedestrian', config: parsed.config, engineVersion: pedestrianEngineId,
    python: config.pedestrianPython, script: pedestrianRunnerScript, env: { ...process.env },
    extraArgs: strictGeometry ? ['--strict-geometry'] : [], executionOptions: { strictGeometry } });
}
export async function checkPedestrianPython(): Promise<{ ok: boolean; detail?: unknown; error?: string }> {
  if (!fs.existsSync(pedestrianRunnerScript)) {
    return { ok: false, error: `缺少脚本 ${pedestrianRunnerScript}` };
  }
  try {
    const scriptDir = path.dirname(pedestrianRunnerScript);
    const env: NodeJS.ProcessEnv = { ...process.env };
    env.PYTHONPATH = [scriptDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const { stdout, stderr, exitCode } = await execSimulation(
      config.pedestrianPython,
      [path.resolve(pedestrianRunnerScript), '--check'],
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
