import type { CapabilityId } from './contracts';
import type { DaylightResult } from './daylight';
import type { SunlightResult } from './sunlight';
import type { PedestrianResult } from './pedestrian';

export type EngineCapability = Extract<CapabilityId, 'daylight' | 'sunlight' | 'pedestrian'>;
export interface EngineResultByCapability { daylight: DaylightResult; sunlight: SunlightResult; pedestrian: PedestrianResult }
export type EngineTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type EngineTaskErrorCode = 'cancelled' | 'timeout' | 'interrupted' | 'spawn_failed' | 'process_exit'
  | 'missing_result' | 'invalid_json' | 'invalid_result' | 'engine_failed' | 'io_error';
export interface EngineTaskEnvelope {
  schemaVersion: '2';
  taskId: string; sessionId: string; revisionId: string; modelRevisionId: string;
  capability: EngineCapability; tool: `${EngineCapability}.run`; executor: 'engine';
  moduleId: string; moduleVersion: string;
  status: EngineTaskStatus;
  phase: 'preparing' | 'executing' | 'reading_result' | 'finished';
  ownerPid: number; timeoutMs: number;
  startedAt: string; updatedAt: string; finishedAt?: string;
  inputHash: string; modelHash: string; configHash: string;
  inputFiles: { model: 'model.frozen.json'; config: string };
  executionOptions: Record<string, unknown>;
  expectedEngineVersion: string; engineVersion: string;
  process?: { exitCode: number | null; terminationSignal: string | null; stdoutTruncated: boolean; stderrTruncated: boolean };
  result?: { path: 'result.json'; schemaVersion?: string; contentHash: string; validated: boolean };
  artifacts: string[];
  error?: { code: EngineTaskErrorCode; message: string };
  /** Historical summary fields remain readable; physical results retain their own schemas. */
  metrics?: unknown; spaces?: unknown; allocations?: unknown; targets?: unknown; verification?: unknown; sampling?: unknown;
}
export interface EngineTaskOutput<Result> { taskId: string; inputHash: string; result: Result; simulationDir: string }
