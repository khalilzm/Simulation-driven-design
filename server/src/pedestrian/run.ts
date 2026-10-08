import { execSimulation } from '../simulation/process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SpaceModel, PedestrianResult } from '@sdd/shared';
import { parsePedestrianConfig, PEDESTRIAN_RESULT_SCHEMA_VERSION } from '@sdd/shared';
import { config, pedestrianEngineId, pedestrianRunnerScript, workspacesDir } from '../config';
import { computePedestrianInputHash } from './hash';

export interface PedestrianRunInput {
  sessionId: string;
  revisionId: string;
  model: SpaceModel;
  configRaw: unknown;
  /** Legacy call compatibility; the engine always reads the task's frozen inputs. */
  modelPath?: string;
  configPath?: string;
  signal?: AbortSignal;
  strictGeometry?: boolean;
}

export interface PedestrianRunOutput {
  taskId: string;
  inputHash: string;
  result: PedestrianResult;
  simulationDir: string;
}

const DEFAULT_ENGINE = pedestrianEngineId;

export function pedestrianSimulationTaskDir(sessionId: string, taskId: string): string {
  return path.join(workspacesDir, sessionId, 'simulations', taskId);
}

export async function runPedestrianAnalysis(input: PedestrianRunInput): Promise<PedestrianRunOutput> {
  const parsed = parsePedestrianConfig(input.configRaw);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }
  const pedestrianConfig = parsed.config;
  const inputHash = computePedestrianInputHash(input.model, pedestrianConfig, DEFAULT_ENGINE);
  const taskId = randomUUID();
  const simDir = pedestrianSimulationTaskDir(input.sessionId, taskId);
  fs.mkdirSync(simDir, { recursive: true });

  fs.writeFileSync(path.join(simDir, 'model.frozen.json'), JSON.stringify(input.model, null, 2));
  fs.writeFileSync(path.join(simDir, 'pedestrian.frozen.json'), JSON.stringify(pedestrianConfig, null, 2));

  const scriptDir = path.dirname(pedestrianRunnerScript);
  const args = [
    path.resolve(pedestrianRunnerScript),
    '--model',
    path.join(simDir, 'model.frozen.json'),
    '--config',
    path.join(simDir, 'pedestrian.frozen.json'),
    '--output',
    simDir,
    ...(input.strictGeometry ? ['--strict-geometry'] : []),
  ];
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PYTHONPATH = [scriptDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const { stdout, stderr, exitCode } = await execSimulation(config.pedestrianPython, args, scriptDir, env, input.signal);
  const resultPath = path.join(simDir, 'result.json');

  if (!fs.existsSync(resultPath)) {
    const detail = stderr.trim() || stdout.trim() || `python exit ${exitCode}`;
    throw new Error(`人流疏散计算未生成 result.json: ${detail}`);
  }

  const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as PedestrianResult;
  const result: PedestrianResult = {
    schemaVersion: raw.schemaVersion ?? PEDESTRIAN_RESULT_SCHEMA_VERSION,
    status: raw.status === 'completed' ? 'completed' : 'failed',
    engineVersion: raw.engineVersion ?? DEFAULT_ENGINE,
    scenario: raw.scenario ?? 'egress',
    metrics: raw.metrics,
    densityGrid: raw.densityGrid,
    trajectories: raw.trajectories,
    verification: raw.verification ?? { status: 'needs_review', checks: [] },
    error: raw.error,
  };

  const envelope = {
    schemaVersion: '1',
    taskId,
    sessionId: input.sessionId,
    revisionId: input.revisionId,
    tool: 'pedestrian.run',
    executor: 'engine',
    inputHash,
    engineVersion: result.engineVersion,
    status: result.status,
    metrics: result.metrics,
    verification: result.verification,
    artifacts: ['result.json'],
  };
  fs.writeFileSync(path.join(simDir, 'envelope.json'), JSON.stringify(envelope, null, 2));
  if (stdout.trim() || stderr.trim()) {
    fs.writeFileSync(path.join(simDir, 'runner.log'), `${stdout}\n${stderr}`.trim());
  }

  return { taskId, inputHash, result, simulationDir: simDir };
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
