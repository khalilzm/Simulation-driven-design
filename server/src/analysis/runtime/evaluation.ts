import fs from 'node:fs';
import { EngineTaskExecutionError } from './task';
import type { ResultIdentity } from '@sdd/shared';
import { canonicalHash, sameCachedResult } from './identity';

export interface EvaluationSnapshot { file: string; inputHash: string; identity?: ResultIdentity }
export interface EvaluationRecord<Result, Assessment> {
  identity?: ResultIdentity;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';
  revisionId: string;
  inputHash: string;
  startedAt: string;
  finishedAt?: string;
  taskId?: string;
  result?: Result;
  evaluation?: Assessment;
  error?: string;
}

/** Lifecycle is shared; the scenario owns input identity, engine calls and target assessment. */
export function createEvaluationRuntime<Input extends EvaluationSnapshot, Result, Assessment,
  Record extends EvaluationRecord<Result, Assessment>>(options: {
    inputs(sessionId: string, revisionId: string): Input;
    createRecord(input: Input, revisionId: string): Record;
    assess(input: Input, result: Result): Assessment;
    validateResult(result: Result): void;
    messages: { stale: string; interrupted: string; concurrent: string };
  }) {
  const active = new Set<string>();
  const loadInput = (input: Input): Record | null => {
    if (!fs.existsSync(input.file)) return null;
    const record = JSON.parse(fs.readFileSync(input.file, 'utf8')) as Record;
    if (record.inputHash !== input.inputHash || (input.identity && !sameCachedResult(record.identity, input.identity))) return { ...record, status: 'stale', result: undefined,
      evaluation: undefined, error: options.messages.stale };
    if (input.identity && record.status === 'completed') {
      try {
        if (record.result === undefined || record.evaluation === undefined) throw new Error('评价数据缺失');
        options.validateResult(record.result);
      } catch { return { ...record, status: 'stale', result: undefined, evaluation: undefined, error: options.messages.stale }; }
    }
    if (record.status === 'running' && !active.has(input.file)) return { ...record, status: 'failed', error: options.messages.interrupted };
    return record;
  };
  return {
    load(sessionId: string, revisionId: string): Record | null {
      return loadInput(options.inputs(sessionId, revisionId));
    },
    async run(sessionId: string, revisionId: string, signal: AbortSignal | undefined,
      analyze: (input: Input, signal?: AbortSignal) => Promise<{ taskId: string; result: Result }>): Promise<Record> {
      const input = options.inputs(sessionId, revisionId);
      if (active.has(input.file)) throw new Error(options.messages.concurrent);
      const previous = loadInput(input);
      if (previous?.status === 'completed') return previous;
      if (previous?.status === 'stale' && fs.existsSync(input.file)) {
        const raw = fs.readFileSync(input.file, 'utf8');
        const directory = input.file + '.history';
        fs.mkdirSync(directory, { recursive: true });
        const id = canonicalHash(JSON.parse(raw)).slice('sha256:'.length);
        fs.writeFileSync(`${directory}/${id}.json`, raw);
      }
      const record = options.createRecord(input, revisionId);
      active.add(input.file);
      const write = () => {
        fs.writeFileSync(input.file + '.tmp', JSON.stringify(record, null, 2));
        fs.renameSync(input.file + '.tmp', input.file);
      };
      try {
        write();
        signal?.throwIfAborted();
        const output = await analyze(input, signal);
        signal?.throwIfAborted();
        record.taskId = output.taskId;
        record.result = output.result;
        options.validateResult(output.result);
        record.evaluation = options.assess(input, output.result);
        record.status = 'completed';
      } catch (error) {
        if (error instanceof EngineTaskExecutionError) record.taskId = error.taskId;
        record.status = signal?.aborted ? 'cancelled' : 'failed';
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        record.finishedAt = new Date().toISOString();
        try { write(); } finally { active.delete(input.file); }
      }
      return record;
    },
  };
}
