import type { ProviderId } from './contracts';
import type { DesignPatch } from './designPatch';
import type { PedestrianConfig, PedestrianResult } from './pedestrian';
import type { SunlightAllocationMetrics, SunlightConfig, SunlightResult, SunlightSpaceMetrics } from './sunlight';
import type { SpaceModel } from './model';

/** First pass deliberately has one objective, one operation and two candidates. */
export const OPTIMIZATION_POLICY = {
  version: 'door-width-v1',
  maxRounds: 1,
  timeoutMs: 300_000,
  minImprovementSec: 0.1,
  sunlightToleranceHours: 1e-6,
} as const;

export interface OptimizationRequest {
  sessionId: string;
  revisionId: string;
  provider: ProviderId;
  message: string;
  openingId: string;
  expectedWidthM: number;
  maxWidthM: number;
  confirmEditable: boolean;
}

export type AutomaticOptimizationRequest = Pick<OptimizationRequest, 'sessionId' | 'revisionId' | 'provider'>;

export const AUTOMATIC_OPTIMIZATION = {
  maxIncreaseM: 0.2,
  message: '缩短疏散清空时间，保持各空间日照，尽量少增宽。',
} as const;

export interface OptimizationEvaluation {
  scenarioHash: string;
  sunlight: {
    taskId: string;
    inputHash: string;
    engineVersion: string;
    spaces: SunlightSpaceMetrics[];
    /** 按逻辑功能（allocationId）汇总；存在时用于功能键比较（目标随功能迁移）。 */
    allocations?: SunlightAllocationMetrics[];
    targetAreaRatio: number | null;
  };
  pedestrian: {
    taskId: string;
    inputHash: string;
    engineVersion: string;
    totalAgents: number;
    egressTimeSec: number | null;
  };
}

/** 统一评价层：分别记录执行成功、输入适用、数值完整、设计约束满足、性能目标满足。 */
export type EvaluationCategory = 'execution' | 'applicability' | 'completeness' | 'constraint' | 'goal';

export interface EvaluationCheck {
  category: EvaluationCategory;
  passed: boolean;
  message: string;
}

export interface OptimizationAssessment {
  eligible: boolean;
  improved: boolean;
  reasons: string[];
  improvementSec: number | null;
  worstMeanHoursDelta: number | null;
  /** 可比性（执行成功 + 输入适用 + 数值完整）。 */
  comparable: boolean;
  /** 设计约束满足（锁定/人口守恒/不可退化）。 */
  constraintsSatisfied: boolean;
  /** 性能目标满足（主目标改善）。 */
  goalsSatisfied: boolean;
  checks: EvaluationCheck[];
}

export interface OptimizationCandidate {
  id: string;
  patch: DesignPatch;
  /** 从基线到该候选的完整补丁链；首轮为 [patch]，后续轮次为父链 + patch。省略时视为 [patch]。 */
  lineage?: DesignPatch[];
  /** 父候选 ID（首轮候选无）。 */
  parentId?: string;
  rationale: string;
  status: 'pending' | 'running' | 'completed' | 'rejected' | 'failed';
  modelHash?: string;
  evaluation?: OptimizationEvaluation;
  assessment?: OptimizationAssessment;
  error?: string;
}

/** 补丁的可读摘要，用于进度与候选展示。 */
export function patchSummary(patch: DesignPatch): string {
  if (patch.type === 'resizeOpening') return `门宽 ${patch.expectedWidthM.toFixed(2)} → ${patch.widthM.toFixed(2)} m`;
  if (patch.type === 'moveOpening') return `门位 ${patch.expectedPosition.toFixed(2)} → ${patch.position.toFixed(2)} m`;
  if (patch.type === 'offsetPartition') return `隔墙 ${patch.wallId} 偏移 ${patch.offsetM >= 0 ? '+' : ''}${patch.offsetM.toFixed(2)} m`;
  if (patch.type === 'swapProgram') return `功能交换 ${patch.spaceA} ↔ ${patch.spaceB}`;
  if (patch.type === 'resizeWindow') return `外窗宽 ${patch.expectedWidthM.toFixed(2)} → ${patch.widthM.toFixed(2)} m`;
  return `外窗位 ${patch.expectedPosition.toFixed(2)} → ${patch.position.toFixed(2)} m`;
}

/** 补丁的「改造量」排序键：增宽按目标宽度，移动/隔墙按位移量，功能交换按 0。 */
export function patchSortValue(patch: DesignPatch): number {
  if (patch.type === 'resizeOpening' || patch.type === 'resizeWindow') return patch.widthM;
  if (patch.type === 'moveOpening' || patch.type === 'moveWindow') return Math.abs(patch.position - patch.expectedPosition);
  if (patch.type === 'offsetPartition') return Math.abs(patch.offsetM);
  return 0;
}

/** 多操作候选的摘要：把每个操作的可读摘要用「 + 」连接。 */
export function lineageSummary(lineage: DesignPatch[]): string {
  return lineage.map(patchSummary).join(' + ');
}

export interface OptimizationRun {
  schemaVersion: '1';
  id: string;
  sessionId: string;
  baseRevisionId: string;
  baseModelHash: string;
  scenarioHash: string;
  createdAt: string;
  updatedAt: string;
  status: 'baseline' | 'planning' | 'evaluating' | 'completed' | 'needs_input' | 'cancelled' | 'failed' | 'interrupted';
  request: OptimizationRequest;
  policy: typeof OPTIMIZATION_POLICY;
  configs: { sunlight: SunlightConfig; pedestrian: PedestrianConfig };
  automatic?: { selection: 'narrowest-feasible'; createdConfigs: ('sunlight' | 'pedestrian')[] };
  baseline?: OptimizationEvaluation;
  summary?: string;
  planner?: { promptHash: string; attempts: number };
  candidates: OptimizationCandidate[];
  recommendedCandidateId?: string;
  outcome?: 'improved' | 'no_improvement' | 'incomplete';
  error?: string;
  adopted?: { candidateId: string; revisionId: string };
}

export type OptimizationEvent =
  | { type: 'progress'; message: string }
  | { type: 'run'; run: OptimizationRun }
  | { type: 'error'; message: string };

/** Models and full analysis artifacts from the same frozen optimization batch. */
export interface OptimizationAnalysisView {
  model: SpaceModel;
  sunlight: SunlightResult;
  pedestrian: PedestrianResult;
}

export interface OptimizationComparison {
  run: OptimizationRun;
  candidateId: string;
  baseline: OptimizationAnalysisView;
  candidate: OptimizationAnalysisView;
}

export interface OptimizationSetup {
  modelHash: string;
  configs: OptimizationRun['configs'];
  assumptions: string[];
}

export interface WorkbenchAnalysisRequest extends AutomaticOptimizationRequest {
  expectedModelHash: string;
  configs: OptimizationRun['configs'];
  confirmConditions: boolean;
}

export interface WorkbenchOptimizationRequest extends OptimizationRequest, WorkbenchAnalysisRequest {}

export interface WorkbenchAnalysis {
  id: string;
  sessionId: string;
  revisionId: string;
  modelHash: string;
  scenarioHash: string;
  createdAt: string;
  configs: OptimizationRun['configs'];
  evaluation: OptimizationEvaluation;
  view: OptimizationAnalysisView;
}

export interface OptimizationTaskDraft {
  message: string;
  openingId: string;
  increaseM: number;
}

export interface OptimizationTaskInterpretation extends OptimizationTaskDraft {
  status: 'ready' | 'needs_input';
  summary: string;
}
