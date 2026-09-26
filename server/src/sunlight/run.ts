import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SpaceModel, SunlightResult } from '@sdd/shared';
import { parseSunlightConfig, SUNLIGHT_RESULT_SCHEMA_VERSION } from '@sdd/shared';
import { config, sunlightEngineId, sunlightProcessEnv, sunlightRunnerScript, workspacesDir } from '../config';
import { computeSunlightInputHash } from './hash';

export interface SunlightRunInput {
  sessionId: string;
  revisionId: string;
  model: SpaceModel;
  configRaw: unknown;
  modelPath: string;
  configPath: string;
}

export interface SunlightRunOutput {
  taskId: string;
  inputHash: string;
  result: SunlightResult;
  simulationDir: string;
}

const DEFAULT_ENGINE = sunlightEngineId;

export function simulationTaskDir(sessionId: string, taskId: string): string {
  return path.join(workspacesDir, sessionId, 'simulations', taskId);
}

export async function runSunlightAnalysis(input: SunlightRunInput): Promise<SunlightRunOutput> {
  const parsed = parseSunlightConfig(input.configRaw);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('; '));
  }
  const sunlightConfig = parsed.config;
  const inputHash = computeSunlightInputHash(input.model, sunlightConfig, DEFAULT_ENGINE);
  const taskId = randomUUID();
  const simDir = simulationTaskDir(input.sessionId, taskId);
  fs.mkdirSync(simDir, { recursive: true });

  fs.writeFileSync(path.join(simDir, 'model.frozen.json'), JSON.stringify(input.model, null, 2));
  fs.writeFileSync(path.join(simDir, 'sunlight.frozen.json'), JSON.stringify(sunlightConfig, null, 2));

  const scriptDir = path.dirname(sunlightRunnerScript);
  const args = [
    path.resolve(sunlightRunnerScript),
    '--model',
    path.resolve(input.modelPath),
    '--config',
    path.resolve(input.configPath),
    '--output',
    simDir,
  ];
  const env = sunlightProcessEnv();
  env.PYTHONPATH = [scriptDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  const { stdout, stderr, exitCode } = await execPython(config.sunlightPython, args, scriptDir, env);
  const resultPath = path.join(simDir, 'result.json');

  if (!fs.existsSync(resultPath)) {
    const detail = stderr.trim() || stdout.trim() || `python exit ${exitCode}`;
    throw new Error(`日照计算未生成 result.json: ${detail}`);
  }

  const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as SunlightResult;
  const result: SunlightResult = {
    schemaVersion: raw.schemaVersion ?? SUNLIGHT_RESULT_SCHEMA_VERSION,
    status: raw.status === 'completed' ? 'completed' : 'failed',
    engineVersion: raw.engineVersion ?? DEFAULT_ENGINE,
    metrics: raw.metrics ?? { unit: 'hour', sensorCount: 0, targetAreaRatio: null },
    spaces: raw.spaces ?? [],
    allocations: raw.allocations,
    targets: raw.targets,
    grids: raw.grids,
    legend: raw.legend,
    verification: raw.verification ?? { status: 'needs_review', checks: [] },
    error: raw.error,
  };

  const envelope = {
    schemaVersion: '1',
    taskId,
    sessionId: input.sessionId,
    revisionId: input.revisionId,
    tool: 'sunlight.run',
    executor: 'engine',
    inputHash,
    engineVersion: result.engineVersion,
    status: result.status,
    metrics: result.metrics,
    spaces: result.spaces,
    allocations: result.allocations,
    targets: result.targets,
    verification: result.verification,
    artifacts: ['result.json'],
  };
  fs.writeFileSync(path.join(simDir, 'envelope.json'), JSON.stringify(envelope, null, 2));
  if (stdout.trim() || stderr.trim()) {
    fs.writeFileSync(path.join(simDir, 'runner.log'), `${stdout}\n${stderr}`.trim());
  }

  return { taskId, inputHash, result, simulationDir: simDir };
}

function execPython(
  python: string,
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
  });
}

export async function checkSunlightPython(): Promise<{ ok: boolean; detail?: unknown; error?: string }> {
  if (!fs.existsSync(sunlightRunnerScript)) {
    return { ok: false, error: `缺少脚本 ${sunlightRunnerScript}` };
  }
  try {
    const scriptDir = path.dirname(sunlightRunnerScript);
    const env = sunlightProcessEnv();
    env.PYTHONPATH = [scriptDir, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const { stdout, stderr, exitCode } = await execPython(
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
