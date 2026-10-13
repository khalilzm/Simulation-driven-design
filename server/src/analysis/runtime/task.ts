import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EngineCapability, EngineResultByCapability, EngineTaskEnvelope, EngineTaskErrorCode,
  EngineTaskOutput, EngineTaskStatus, SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../../config';
import { execSimulation, SimulationProcessError, type SimulationProcessOutput } from '../../simulation/process';
import { canonicalHash } from './identity';
import { computeEngineInputHash } from './inputHash';
import { EngineResultError, parseCompletedEngineResult } from './engineResult';

export interface EngineTaskScope {
  sessionId: string; revisionId: string; moduleId?: string; moduleVersion?: string; signal?: AbortSignal; timeoutMs?: number;
}
interface EngineTaskInput<K extends EngineCapability> extends EngineTaskScope {
  capability: K; model: SpaceModel; config: unknown; engineVersion: string;
  python: string; script: string; env: NodeJS.ProcessEnv;
  extraArgs?: string[]; executionOptions?: Record<string, unknown>;
}
export class EngineTaskExecutionError extends Error {
  constructor(message: string, public readonly code: EngineTaskErrorCode, public readonly taskId: string,
    public readonly simulationDir: string, public readonly inputHash: string, public readonly status: EngineTaskStatus,
    options?: ErrorOptions) { super(message, options); this.name = 'EngineTaskExecutionError'; }
}
const active = new Set<string>();
const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file);
};
export function engineTaskDirectory(sessionId: string, taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId) || !/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('分析任务标识无效');
  return path.join(workspacesDir, sessionId, 'simulations', taskId);
}
const processDetails = (output: SimulationProcessOutput): NonNullable<EngineTaskEnvelope['process']> => ({
  exitCode: output.exitCode, terminationSignal: output.terminationSignal,
  stdoutTruncated: output.stdoutTruncated, stderrTruncated: output.stderrTruncated,
});

/** Snapshots and a running record precede the process; every settled invocation records a terminal outcome. */
export async function runEngineTask<K extends EngineCapability>(input: EngineTaskInput<K>,
  execute: typeof execSimulation = execSimulation): Promise<EngineTaskOutput<EngineResultByCapability[K]>> {
  const { capability, engineVersion, signal } = input;
  if (!/^rev-\d+$/.test(input.revisionId)) throw new Error('分析版本无效');
  const moduleId = input.moduleId ?? capability, moduleVersion = input.moduleVersion ?? '1';
  if (!/^[A-Za-z][\w-]{0,99}$/.test(moduleId) || !moduleVersion.trim() || moduleVersion.length > 100) throw new Error('仿真模块标识或版本无效');
  const timeoutMs = input.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('仿真超时设置无效');
  const model = structuredClone(input.model), config = structuredClone(input.config), executionOptions = structuredClone(input.executionOptions ?? {});
  const inputHash = computeEngineInputHash(capability, model, config, engineVersion, executionOptions);
  const taskId = randomUUID(), folder = engineTaskDirectory(input.sessionId, taskId), file = path.join(folder, 'envelope.json');
  const startedAt = new Date().toISOString();
  const envelope: EngineTaskEnvelope = { schemaVersion: '2', taskId, sessionId: input.sessionId, revisionId: input.revisionId,
    modelRevisionId: model.model.revisionId, capability, tool: `${capability}.run`, executor: 'engine',
    moduleId, moduleVersion, status: 'running', phase: 'preparing', ownerPid: process.pid, timeoutMs, startedAt, updatedAt: startedAt,
    inputHash, modelHash: canonicalHash(model), configHash: canonicalHash(config), executionOptions,
    inputFiles: { model: 'model.frozen.json', config: `${capability}.frozen.json` },
    expectedEngineVersion: engineVersion, engineVersion, artifacts: [] };
  fs.mkdirSync(path.dirname(folder), { recursive: true }); fs.mkdirSync(folder);
  active.add(file);
  let output: SimulationProcessOutput | undefined;
  let taskError: EngineTaskExecutionError | undefined;
  const update = () => { envelope.updatedAt = new Date().toISOString(); writeJson(file, envelope); };
  const readRawResult = (): unknown => {
    const resultFile = path.join(folder, 'result.json');
    if (!fs.existsSync(resultFile)) throw new EngineResultError('引擎未生成 result.json', 'missing_result');
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(resultFile, 'utf8')); }
    catch (error) { throw new EngineResultError(`result.json 无法解析：${error instanceof Error ? error.message : String(error)}`, 'invalid_json'); }
    try {
      const object = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
      envelope.result = { path: 'result.json', contentHash: canonicalHash(raw), validated: false,
        ...(typeof object?.schemaVersion === 'string' ? { schemaVersion: object.schemaVersion } : {}) };
      if (typeof object?.engineVersion === 'string') envelope.engineVersion = object.engineVersion;
    } catch { throw new EngineResultError('引擎结果包含非有限数值'); }
    return raw;
  };
  try {
    update();
    writeJson(path.join(folder, envelope.inputFiles.model), model);
    writeJson(path.join(folder, envelope.inputFiles.config), config);
    signal?.throwIfAborted();
    envelope.phase = 'executing'; update();
    const script = path.resolve(input.script), directory = path.dirname(script), env = { ...input.env };
    env.PYTHONPATH = [directory, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    output = await execute(input.python, [script, '--model', path.join(folder, envelope.inputFiles.model),
      '--config', path.join(folder, envelope.inputFiles.config), '--output', folder, ...(input.extraArgs ?? [])], directory, env, signal, timeoutMs);
    envelope.process = processDetails(output); signal?.throwIfAborted();
    envelope.phase = 'reading_result'; update();
    const raw = readRawResult(), result = parseCompletedEngineResult(raw, capability, engineVersion);
    // The engine must not alter the inputs after they have been hashed and frozen.
    if (canonicalHash(JSON.parse(fs.readFileSync(path.join(folder, envelope.inputFiles.model), 'utf8'))) !== envelope.modelHash
      || canonicalHash(JSON.parse(fs.readFileSync(path.join(folder, envelope.inputFiles.config), 'utf8'))) !== envelope.configHash)
      throw new EngineResultError('引擎冻结输入被修改');
    signal?.throwIfAborted();
    envelope.result!.validated = true;
    const summary = result as unknown as Record<string, unknown>;
    for (const key of ['metrics', 'spaces', 'allocations', 'targets', 'verification', 'sampling'] as const)
      if (summary[key] !== undefined) envelope[key] = summary[key];
    envelope.status = 'completed';
    return { taskId, inputHash, result, simulationDir: folder };
  } catch (error) {
    let code: EngineTaskErrorCode = error instanceof EngineResultError ? error.code : 'io_error';
    let message = error instanceof Error ? error.message : String(error);
    if (error instanceof SimulationProcessError) {
      output = error.output; envelope.process = processDetails(output); code = error.code;
      // Preserve engine diagnostics from non-zero exits, without promoting a result to success.
      if (code === 'process_exit' && fs.existsSync(path.join(folder, 'result.json'))) {
        try { parseCompletedEngineResult(readRawResult(), capability, engineVersion); }
        catch (failure) { if (failure instanceof EngineResultError && failure.code === 'engine_failed') { code = failure.code; message = failure.message; } }
      }
    }
    if (signal?.aborted || code === 'cancelled') { code = 'cancelled'; envelope.status = 'cancelled'; message = '仿真已取消'; }
    else envelope.status = code === 'timeout' ? 'timed_out' : 'failed';
    envelope.error = { code, message };
    taskError = new EngineTaskExecutionError(message, code, taskId, folder, inputHash, envelope.status, { cause: error });
    throw taskError;
  } finally {
    envelope.phase = 'finished'; envelope.finishedAt = new Date().toISOString();
    try {
      const diagnostics = [output?.stdout, output?.stderr, envelope.error?.message].filter(Boolean).join('\n');
      fs.writeFileSync(path.join(folder, 'runner.log'), diagnostics);
      envelope.artifacts = fs.readdirSync(folder).filter(name => !name.endsWith('.tmp')).sort();
      update();
    } catch (error) {
      envelope.status = 'failed'; envelope.error = { code: 'io_error', message: error instanceof Error ? error.message : String(error) };
      try { update(); } catch { /* Disk failures cannot guarantee durable recording. */ }
      throw new EngineTaskExecutionError(envelope.error.message, 'io_error', taskId, folder, inputHash, 'failed', { cause: taskError ?? error });
    } finally { active.delete(file); }
  }
}

/** Older completed envelopes stay readable; no missing result metrics or versions are synthesized. */
export interface LegacyEngineTaskEnvelope {
  schemaVersion?: '1'; taskId: string; sessionId: string; revisionId: string; tool: string;
  inputHash: string; status: string; engineVersion?: string;
}
export function loadEngineTaskEnvelope(sessionId: string, taskId: string): EngineTaskEnvelope | LegacyEngineTaskEnvelope {
  const file = path.join(engineTaskDirectory(sessionId, taskId), 'envelope.json');
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!envelope || envelope.taskId !== taskId || envelope.sessionId !== sessionId
    || !['1', '2', undefined].includes(envelope.schemaVersion)) throw new Error('分析任务记录无效');
  if (envelope.schemaVersion !== '2') return envelope as LegacyEngineTaskEnvelope;
  const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  if (!['daylight', 'sunlight', 'pedestrian'].includes(envelope.capability) || envelope.tool !== `${envelope.capability}.run`
    || envelope.executor !== 'engine' || !/^rev-\d+$/.test(envelope.revisionId) || !/^rev-\d+$/.test(envelope.modelRevisionId)
    || !['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(envelope.status)
    || !['preparing', 'executing', 'reading_result', 'finished'].includes(envelope.phase)
    || !Number.isSafeInteger(envelope.ownerPid) || envelope.ownerPid <= 0
    || !Number.isSafeInteger(envelope.timeoutMs) || envelope.timeoutMs <= 0
    || typeof envelope.moduleId !== 'string' || !/^[A-Za-z][\w-]{0,99}$/.test(envelope.moduleId)
    || typeof envelope.moduleVersion !== 'string' || !envelope.moduleVersion.trim()
    || typeof envelope.expectedEngineVersion !== 'string' || !envelope.expectedEngineVersion.trim()
    || !digest(envelope.inputHash) || !digest(envelope.modelHash) || !digest(envelope.configHash)
    || envelope.inputFiles?.model !== 'model.frozen.json' || envelope.inputFiles?.config !== `${envelope.capability}.frozen.json`
    || !envelope.executionOptions || typeof envelope.executionOptions !== 'object' || Array.isArray(envelope.executionOptions)
    || !Array.isArray(envelope.artifacts) || envelope.artifacts.some((item: unknown) => typeof item !== 'string')
    || typeof envelope.startedAt !== 'string' || typeof envelope.updatedAt !== 'string'
    || (envelope.status !== 'running' && (envelope.phase !== 'finished' || typeof envelope.finishedAt !== 'string')))
    throw new Error('分析任务记录无效');
  if (envelope.status === 'running' && !active.has(file)) {
    let ownerAlive = envelope.ownerPid !== process.pid;
    if (ownerAlive) try { process.kill(envelope.ownerPid, 0); } catch (error) { ownerAlive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (!ownerAlive) return { ...envelope, status: 'interrupted', phase: 'finished', error: { code: 'interrupted', message: '任务进程已结束，结果尚未完成，请重新运行' } };
  }
  return envelope as EngineTaskEnvelope;
}
export function loadCompletedEngineResult<K extends EngineCapability>(sessionId: string, taskId: string, capability: K): EngineResultByCapability[K] {
  const folder = engineTaskDirectory(sessionId, taskId), envelope = loadEngineTaskEnvelope(sessionId, taskId);
  if (envelope.status !== 'completed' || envelope.tool !== `${capability}.run`) throw new Error('分析任务未完成或能力不匹配');
  const raw = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
  if (envelope.schemaVersion !== '2') {
    if (!raw || raw.status !== 'completed' || typeof raw.engineVersion !== 'string'
      || (envelope.engineVersion !== undefined && envelope.engineVersion !== raw.engineVersion)) throw new Error('历史分析结果尚未完成或引擎版本不匹配');
    return raw as EngineResultByCapability[K];
  }
  const modern = envelope as EngineTaskEnvelope;
  if (!modern.result?.validated || modern.result.path !== 'result.json' || canonicalHash(raw) !== modern.result.contentHash
    || modern.engineVersion !== modern.expectedEngineVersion || modern.result.schemaVersion !== raw.schemaVersion
    || modern.inputFiles.model !== 'model.frozen.json' || modern.inputFiles.config !== `${capability}.frozen.json`) throw new Error('分析结果或输入快照已变化');
  const model = JSON.parse(fs.readFileSync(path.join(folder, modern.inputFiles.model), 'utf8')) as SpaceModel;
  const config = JSON.parse(fs.readFileSync(path.join(folder, modern.inputFiles.config), 'utf8'));
  if (model.model.revisionId !== modern.modelRevisionId || canonicalHash(model) !== modern.modelHash || canonicalHash(config) !== modern.configHash
    || computeEngineInputHash(capability, model, config, modern.expectedEngineVersion, modern.executionOptions) !== modern.inputHash)
    throw new Error('分析结果或输入快照已变化');
  return parseCompletedEngineResult(raw, capability, modern.expectedEngineVersion);
}
