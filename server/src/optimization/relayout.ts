import fs from 'node:fs';
import path from 'node:path';
import { OPTIMIZATION_POLICY, type OptimizationAssessment, type OptimizationEvaluation, type OptimizationRun, type SpaceModel } from '@sdd/shared';
import type { DesignIntent } from '../design/intent';
import { parseDesignIntent } from '../design/intent';
import { createLayoutContext } from '../design/layoutContext';
import { compileIntent } from '../design/layoutIntent';
import { buildIntentPrompt } from '../design/spaceAgentPrompts';
import type { ProviderAdapter } from '../providers/types';
import { outlineToText, type OutlineContext } from '../spacePrompt';
import { compareCandidate } from './evaluate';
import { evaluateModel, type EvaluateModel } from './simulate';
import { hashValue } from './store';

/**
 * 布局重排：用新意图重排内部布局，保留基线外轮廓、层高与固定构件（父方案）。
 * 与局部补丁（applyDesignPatch）互补——补丁在原地微调，重排整体再生成。
 */
export function compileRelayoutModel(baseline: SpaceModel, intent: DesignIntent, revisionId: string): SpaceModel {
  const outline = JSON.stringify({ boundary: baseline.floor.boundary, origin: baseline.model.origin, units: baseline.model.units });
  const ctx = createLayoutContext(outline, baseline);
  return compileIntent(intent, ctx, revisionId).model;
}

export interface RelayoutCandidate {
  id: string;
  intent: DesignIntent;
  modelHash: string;
  evaluation: OptimizationEvaluation;
  assessment: OptimizationAssessment;
}

export interface RelayoutResult {
  baseline: OptimizationEvaluation;
  candidates: RelayoutCandidate[];
  recommendedId?: string;
}

function recommendRelayout(candidates: RelayoutCandidate[]): string | undefined {
  const eligible = candidates.filter((c) => c.assessment.improved && c.evaluation.pedestrian.egressTimeSec !== null);
  if (!eligible.length) return undefined;
  const fastest = Math.min(...eligible.map((c) => c.evaluation.pedestrian.egressTimeSec!));
  return eligible
    .filter((c) => c.evaluation.pedestrian.egressTimeSec! <= fastest + OPTIMIZATION_POLICY.minImprovementSec)
    .sort((a, b) => a.id.localeCompare(b.id))[0].id;
}

/** 让 Agent 用布局意图提示词提出一个重排意图（写 intent.json 并解析校验）。 */
export async function proposeRelayoutIntent(
  adapter: ProviderAdapter,
  baseline: SpaceModel,
  cwd: string,
  revisionId: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ summary: string; intents: DesignIntent[] }> {
  const ctx: OutlineContext = { source: 'parent', outline: outlineToText(baseline), currentModel: baseline, workspaceDir: cwd };
  const prompt = buildIntentPrompt(revisionId, ctx);
  await adapter.run({ cwd, message, systemPrompt: prompt }, () => {}, signal);
  const intentPath = path.join(cwd, 'designs', revisionId, 'intent.json');
  if (!fs.existsSync(intentPath)) throw new Error('Agent 未生成 intent.json');
  const parsed = parseDesignIntent(JSON.parse(fs.readFileSync(intentPath, 'utf8')));
  if (!parsed.ok) throw new Error(parsed.errors.join('；'));
  return { summary: message, intents: [parsed.intent] };
}

/** 单轮布局重排：基线 → 提意图 → 编译 → 复算 → 比较 → 推荐。propose 由调用方注入（生产接 Agent）。 */
export async function runRelayoutOptimization(
  ctx: { sessionId: string; baseRevisionId: string; scenarioHash: string; configs: OptimizationRun['configs'] },
  model: SpaceModel,
  propose: () => Promise<{ summary: string; intents: DesignIntent[] }>,
  signal: AbortSignal,
  progress: (message: string) => void,
  evaluate: EvaluateModel = evaluateModel,
): Promise<RelayoutResult> {
  progress('建立基线：沿用当前日照工况、人数与随机种子');
  const baseline = await evaluate(model, ctx, signal, progress);
  signal.throwIfAborted();
  progress('Agent 提出整体重排意图…');
  const { intents } = await propose();
  signal.throwIfAborted();
  const candidates: RelayoutCandidate[] = [];
  for (let i = 0; i < intents.length; i++) {
    signal.throwIfAborted();
    progress(`评估重排候选 ${i + 1}：${intents[i].rooms.map((r) => r.usage).join('、')}`);
    const child = compileRelayoutModel(model, intents[i], `${ctx.baseRevisionId}-relayout-${i + 1}`);
    const evaluation = await evaluate(child, ctx, signal, progress);
    const assessment = compareCandidate(baseline, evaluation);
    candidates.push({ id: `relayout-${i + 1}`, intent: intents[i], modelHash: hashValue(child), evaluation, assessment });
  }
  return { baseline, candidates, recommendedId: recommendRelayout(candidates) };
}
