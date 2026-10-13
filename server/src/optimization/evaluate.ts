import { OPTIMIZATION_POLICY, patchSortValue, type EvaluationCategory, type EvaluationCheck,
  type OptimizationAssessment, type OptimizationCandidate, type OptimizationEvaluation } from '@sdd/shared';
import { comparableIdentities, identityEngineVersionsMatch } from '../analysis/runtime/identity';

interface SunlightRow {
  id: string;
  sensorCount: number;
  sampledArea?: number;
  meanHours: number;
  minHours: number;
  maxHours: number;
  targetMetRatio: number | null;
}

/** 优先按逻辑功能（allocationId）比较；缺失时回退到物理空间。 */
function sunlightRows(sun: OptimizationEvaluation['sunlight']): SunlightRow[] {
  if (sun.allocations?.length) {
    return sun.allocations.map((a) => ({ id: a.allocationId, sensorCount: a.sensorCount, sampledArea: a.sampledArea,
      meanHours: a.meanHours, minHours: a.minHours, maxHours: a.maxHours, targetMetRatio: a.targetMetRatio }));
  }
  return sun.spaces.map((s) => ({ id: s.spaceId, sensorCount: s.sensorCount, sampledArea: s.sampledArea,
    meanHours: s.meanHours, minHours: s.minHours, maxHours: s.maxHours, targetMetRatio: s.targetMetRatio }));
}

/**
 * 纯策略、与 provider 无关。缺失结果永远得不到好分数。
 * 统一评价层：把可比性（工况/引擎/人口/评价范围一致）、数值完整（测点/清空）、
 * 设计约束（日照不退化）与性能目标（疏散改善）分开记录，避免把「未清空」误判为更优。
 */
export function compareCandidate(base: OptimizationEvaluation, next: OptimizationEvaluation): OptimizationAssessment {
  const checks: EvaluationCheck[] = [];
  const add = (category: EvaluationCategory, passed: boolean, message: string) =>
    checks.push({ category, passed, message });

  // 输入适用（可比性）
  add('applicability', comparableIdentities(base.identity, next.identity), '结果身份完整且场景、规则、输入版本和分析计划一致');
  const matches = (evaluation: OptimizationEvaluation) => identityEngineVersionsMatch(evaluation.identity,
    {sunlight:evaluation.sunlight.engineVersion,pedestrian:evaluation.pedestrian.engineVersion});
  add('applicability', matches(base) && matches(next), '结果报告的引擎版本与身份声明一致');
  add('applicability', base.scenarioHash === next.scenarioHash, '仿真工况一致');
  add('applicability', base.sunlight.engineVersion === next.sunlight.engineVersion
    && base.pedestrian.engineVersion === next.pedestrian.engineVersion, '仿真引擎版本一致');
  add('applicability', base.pedestrian.totalAgents === next.pedestrian.totalAgents, '疏散人数一致');
  const baseRows = sunlightRows(base.sunlight);
  const nextRows = sunlightRows(next.sunlight);
  const rows = new Map(nextRows.map((s) => [s.id, s]));
  add('applicability', rows.size === baseRows.length, '日照评价对象一致');

  const hasTargets = baseRows.some((r) => r.targetMetRatio !== null);
  const deltas: number[] = [];
  for (const old of baseRows) {
    const current = rows.get(old.id);
    if (!current || !current.sensorCount || !Number.isFinite(current.sampledArea) || current.sampledArea! <= 0) {
      add('completeness', false, `对象 ${old.id} 缺少有效日照测点`);
      continue;
    }
    const delta = current.meanHours - old.meanHours;
    deltas.push(delta);
    if (!Number.isFinite(delta) || !Number.isFinite(current.minHours)) {
      add('completeness', false, `对象 ${old.id} 的日照指标缺失`);
      continue;
    }
    // 有目标时仅保护基线有目标的对象（无目标对象可随功能交换让渡日照）；无目标时保护全部对象。
    const protect = old.targetMetRatio !== null || !hasTargets;
    if (!protect) continue;
    if (delta < -OPTIMIZATION_POLICY.sunlightToleranceHours
      || current.minHours < old.minHours - OPTIMIZATION_POLICY.sunlightToleranceHours
      || (old.targetMetRatio !== null && (current.targetMetRatio === null
        || !Number.isFinite(current.targetMetRatio) || current.targetMetRatio < old.targetMetRatio - 1e-9))) {
      add('constraint', false, `对象 ${old.id} 的日照保护指标退化或缺失`);
    }
  }

  const duration = next.pedestrian.egressTimeSec;
  add('completeness', duration !== null && Number.isFinite(duration) && duration > 0, '候选完成全部人员疏散');

  const improvementSec = base.pedestrian.egressTimeSec !== null && duration !== null
    ? base.pedestrian.egressTimeSec - duration : null;
  const goalPassed = base.pedestrian.egressTimeSec === null
    || (improvementSec !== null && improvementSec > OPTIMIZATION_POLICY.minImprovementSec + 1e-9);
  add('goal', goalPassed, goalPassed ? '清空时间改善超过阈值' : `清空时间未改善超过 ${OPTIMIZATION_POLICY.minImprovementSec} 秒`);

  const byCategory = (category: EvaluationCategory) => checks.filter((c) => c.category === category);
  const comparable = byCategory('applicability').every((c) => c.passed) && byCategory('completeness').every((c) => c.passed);
  const constraintsSatisfied = byCategory('constraint').every((c) => c.passed);
  const goalsSatisfied = byCategory('goal').every((c) => c.passed);
  const eligible = comparable && constraintsSatisfied;
  const improved = eligible && goalsSatisfied;

  return { eligible, improved, reasons: checks.filter((c) => !c.passed).map((c) => c.message), improvementSec,
    worstMeanHoursDelta: deltas.length && deltas.every(Number.isFinite) ? Math.min(...deltas) : null,
    comparable, constraintsSatisfied, goalsSatisfied, checks };
}

export function recommendCandidate(candidates: OptimizationCandidate[]): string | undefined {
  const eligible = candidates.filter((c) => c.status === 'completed' && c.assessment?.improved && c.evaluation);
  if (!eligible.length) return undefined;
  const fastest = Math.min(...eligible.map((c) => c.evaluation!.pedestrian.egressTimeSec!));
  // Near ties prefer less construction; using a fixed best avoids a non-transitive comparator.
  return eligible.filter((c) => c.evaluation!.pedestrian.egressTimeSec! <= fastest + OPTIMIZATION_POLICY.minImprovementSec)
    .sort((a, b) => patchSortValue(a.patch) - patchSortValue(b.patch) || a.id.localeCompare(b.id))[0].id;
}
