import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OPTIMIZATION_POLICY, parsePedestrianConfig, parseSunlightConfig, lineageSummary,
  type DesignPatch, type MoveWindowPatch, type OptimizationEvent, type OptimizationRequest,
  type OptimizationRun, type ResizeWindowPatch, type SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../config';
import { isAcceptedDesign, loadDesign, saveDesign } from '../model/store';
import { getAdapter, isValidProvider } from '../providers/registry';
import { loadSession } from '../sessions/store';
import { readSketchReport } from '../sketch/runSketchTurn';
import type { ProviderAdapter } from '../providers/types';
import { compareCandidate, recommendCandidate } from './evaluate';
import { applyDesignPatch, candidatePartitionOffsets, candidatePatches, candidateProgramSwaps, candidateWindowPatches, validateOptimizationModel } from './patch';
import { planPatches } from './planner';
import { evaluateModel, type EvaluateModel } from './simulate';
import { hashValue, liveOptimizationRuns, loadCandidateModel, loadOptimization, optimizationDir,
  saveOptimization, validRevisionId, validSessionId, writeJson } from './store';

export function parseOptimizationRequest(raw: unknown): OptimizationRequest {
  const r = raw as OptimizationRequest;
  if (!r || typeof r !== 'object' || !validSessionId(r.sessionId) || !validRevisionId(r.revisionId)
    || !isValidProvider(r.provider) || r.provider === 'echo'
    || typeof r.message !== 'string' || !r.message.trim() || r.message.length > 4000
    || typeof r.openingId !== 'string' || !r.openingId || r.openingId.length > 200
    || !Number.isFinite(r.expectedWidthM) || r.expectedWidthM <= 0 || !Number.isFinite(r.maxWidthM)
    || r.maxWidthM - r.expectedWidthM < 0.02 - 1e-6 || r.maxWidthM - r.expectedWidthM > 0.6 + 1e-6
    || r.confirmEditable !== true) {
    throw new Error('请选择方案、门洞及可用 Agent，填写目标并确认可改范围；首轮增宽上限须为 0.02～0.6 米');
  }
  return { sessionId: r.sessionId, revisionId: r.revisionId, provider: r.provider, message: r.message.trim(),
    openingId: r.openingId, expectedWidthM: r.expectedWidthM, maxWidthM: r.maxWidthM, confirmEditable: true };
}

function readInputs(sessionId: string, revisionId: string, baseline?: SpaceModel) {
  const model = baseline ?? loadDesign(sessionId, revisionId);
  if (!model || !isAcceptedDesign(sessionId, revisionId, model)) throw new Error('基线方案不存在或几何无效');
  const dir = path.join(workspacesDir, sessionId, 'designs', revisionId);
  if (!fs.existsSync(path.join(dir, 'sunlight.json')) || !fs.existsSync(path.join(dir, 'pedestrian.json'))) {
    throw new Error('请先保存日照设置并运行一次疏散分析，优化将沿用这两份工况和人数');
  }
  const sunlight = parseSunlightConfig(JSON.parse(fs.readFileSync(path.join(dir, 'sunlight.json'), 'utf8')));
  const pedestrian = parsePedestrianConfig(JSON.parse(fs.readFileSync(path.join(dir, 'pedestrian.json'), 'utf8')));
  if (!sunlight.ok) throw new Error(sunlight.errors.join('；'));
  if (!pedestrian.ok) throw new Error(pedestrian.errors.join('；'));
  return { model, configs: { sunlight: sunlight.config, pedestrian: pedestrian.config } };
}

export function loadOptimizationBaseline(request: Pick<OptimizationRequest, 'sessionId' | 'revisionId' | 'provider'>): SpaceModel {
  const session = loadSession(request.sessionId);
  if (session && session.provider !== request.provider) throw new Error('所选 Agent 与当前会话不一致');
  const model = loadDesign(request.sessionId, request.revisionId);
  if (!model || !isAcceptedDesign(request.sessionId, request.revisionId, model)) throw new Error('基线方案不存在或几何无效');
  validateOptimizationModel(model);
  if (model.model.sketchId && !readSketchReport(path.join(workspacesDir, request.sessionId), request.revisionId)?.calibrated) {
    throw new Error('草图缺少真实尺寸，请先校准后再进行物理优化');
  }
  return model;
}

export function prepareOptimization(request: OptimizationRequest, suppliedConfigs?: OptimizationRun['configs']): { run: OptimizationRun; model: SpaceModel } {
  const model = loadOptimizationBaseline(request);
  const configs = suppliedConfigs ?? readInputs(request.sessionId, request.revisionId, model).configs;
  if (configs.pedestrian.model !== 'collision-free') throw new Error('首轮优化仅支持 collision-free 疏散工况');
  if (configs.pedestrian.agents.some((a) => !model.spaces.some((s) => s.id === a.spaceId))) {
    throw new Error('疏散人数配置引用了不存在的空间');
  }
  const ids = new Set(model.spaces.flatMap((s) => [s.id, s.allocationId ?? s.id]));
  if (configs.sunlight.targets?.some((target) => target.spaceIds.some((id) => !ids.has(id)))) {
    throw new Error('日照目标引用了不存在的空间，请在日照设置中修正');
  }
  // Verify at least one proposed change is geometrically possible before spending model/simulation calls.
  const errors: string[] = [];
  if (!candidatePatches(model, request).some((patch) => {
    try { applyDesignPatch(model, patch); return true; }
    catch (error) { errors.push(String(error)); return false; }
  })) throw new Error(errors.join('；'));
  const now = new Date().toISOString();
  const run: OptimizationRun = { schemaVersion: '1', id: randomUUID(), sessionId: request.sessionId,
    baseRevisionId: request.revisionId, baseModelHash: hashValue(model), scenarioHash: hashValue(configs),
    createdAt: now, updatedAt: now, status: 'baseline', request, policy: OPTIMIZATION_POLICY, configs, candidates: [] };
  return { run, model };
}

/** 有限轮次搜索：每轮在上轮较优候选上继续，去重、连续无改善时停止。试算模型不进入 designs/，直到采用。 */
export async function runOptimization(run: OptimizationRun, model: SpaceModel,
  emit: (event: OptimizationEvent) => void, signal: AbortSignal,
  deps: { adapter?: ProviderAdapter; evaluate?: EvaluateModel; baseline?: OptimizationRun['baseline'] } = {}): Promise<void> {
  const evaluate = deps.evaluate ?? evaluateModel;
  const progress = (message: string) => emit({ type: 'progress', message });
  const snapshot = () => { saveOptimization(run); emit({ type: 'run', run: structuredClone(run) }); };
  liveOptimizationRuns.add(run.id);
  try {
    writeJson(path.join(optimizationDir(run.sessionId, run.id), 'baseline.json'), model);
    snapshot();
    signal.throwIfAborted();
    progress(deps.baseline ? '复用同一模型与工况下的现状分析' : '建立基线：沿用当前日照工况、人数与随机种子');
    run.baseline = deps.baseline ?? await evaluate(model, run, signal, progress);
    signal.throwIfAborted();

    let currentModel = model;
    let parentId: string | undefined;
    let parentLineage: DesignPatch[] = [];
    let counter = 0;
    const seenHashes = new Set<string>();
    let bestEgress: number | null = null;

    for (let round = 1; round <= OPTIMIZATION_POLICY.maxRounds; round++) {
      signal.throwIfAborted();
      run.status = 'planning'; snapshot();
      const currentDoor = currentModel.openings.find((o) => o.id === run.request.openingId);
      const currentRequest = currentDoor ? { ...run.request, expectedWidthM: currentDoor.width } : run.request;
      const allowed = [...candidatePatches(currentModel, currentRequest), ...candidatePartitionOffsets(currentModel, run.baseline), ...candidateProgramSwaps(currentModel, run.baseline), ...candidateWindowPatches(currentModel, run.baseline)]
        .filter((patch) => {
          try { applyDesignPatch(currentModel, patch); return true; } catch { return false; }
        });
      if (!allowed.length) break;
      const allowedWidths = allowed.filter((p) => p.type === 'resizeOpening').map((p) => p.widthM);
      const allowedPositions = allowed.filter((p) => p.type === 'moveOpening').map((p) => p.position);
      const allowedPartitions = allowed.filter((p) => p.type === 'offsetPartition').map((p) => ({ wallId: p.wallId, offsetM: p.offsetM }));
      const allowedSwaps = allowed.filter((p) => p.type === 'swapProgram').map((p) => ({ spaceA: p.spaceA, spaceB: p.spaceB }));
      const allowedWindowResizes: ResizeWindowPatch[] = allowed.filter((p): p is ResizeWindowPatch => p.type === 'resizeWindow');
      const allowedWindowMoves: MoveWindowPatch[] = allowed.filter((p): p is MoveWindowPatch => p.type === 'moveWindow');
      progress(round === 1 ? 'Agent 理解目标并组合候选方案…' : `第 ${round} 轮：在上轮较优候选上继续搜索…`);
      let proposal;
      try {
        proposal = await planPatches(run, currentModel, allowedWidths, allowedPositions, allowedPartitions, allowedSwaps, allowedWindowResizes, allowedWindowMoves, deps.adapter ?? getAdapter(run.request.provider), signal, progress);
      } catch (error) {
        if (round === 1) throw error;
        break;
      }
      if (round === 1) run.summary = proposal.summary;
      if (proposal.status === 'needs_input') { if (round === 1) { run.status = 'needs_input'; snapshot(); return; } break; }
      const roundCandidates: OptimizationRun['candidates'] = proposal.candidates.map((c) => ({
        id: `candidate-${++counter}`, patch: c.patch, lineage: [...parentLineage, ...c.lineage], parentId,
        rationale: c.rationale, status: 'pending',
      }));
      run.candidates.push(...roundCandidates);
      run.status = 'evaluating'; snapshot();

      let roundBest: (typeof roundCandidates)[number] | undefined;
      let roundBestModel: SpaceModel | undefined;
      for (const candidate of roundCandidates) {
        signal.throwIfAborted();
        candidate.status = 'running'; snapshot();
        progress(`评估 ${candidate.id}：${lineageSummary(candidate.lineage ?? [candidate.patch])}`);
        try {
          const child = candidate.lineage!.reduce((m, p) => applyDesignPatch(m, p), model);
          const childHash = hashValue(child);
          if (seenHashes.has(childHash)) { candidate.status = 'rejected'; snapshot(); continue; }
          seenHashes.add(childHash);
          candidate.modelHash = childHash;
          writeJson(path.join(optimizationDir(run.sessionId, run.id), `${candidate.id}.json`), child);
          candidate.evaluation = await evaluate(child, run, signal, progress);
          signal.throwIfAborted();
          candidate.assessment = compareCandidate(run.baseline, candidate.evaluation);
          candidate.status = candidate.assessment.eligible ? 'completed' : 'rejected';
          const egress = candidate.evaluation.pedestrian.egressTimeSec;
          const improves = candidate.assessment.improved && egress !== null
            && (bestEgress === null || egress < bestEgress - OPTIMIZATION_POLICY.minImprovementSec);
          if (improves && (!roundBest || (egress ?? Infinity) < (roundBest.evaluation?.pedestrian.egressTimeSec ?? Infinity))) {
            roundBest = candidate;
            roundBestModel = child;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          candidate.status = 'failed';
          candidate.error = error instanceof Error ? error.message : String(error);
        }
        snapshot();
      }
      if (!roundBest || !roundBestModel) break;
      bestEgress = roundBest.evaluation!.pedestrian.egressTimeSec;
      currentModel = roundBestModel;
      parentId = roundBest.id;
      parentLineage = roundBest.lineage!;
    }

    run.recommendedCandidateId = recommendCandidate(run.candidates);
    run.outcome = run.recommendedCandidateId ? 'improved'
      : run.candidates.some((c) => c.status === 'failed') ? 'incomplete' : 'no_improvement';
    run.status = 'completed';
    snapshot();
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'failed';
    run.error = signal.aborted ? String(signal.reason?.message ?? '任务已取消') : error instanceof Error ? error.message : String(error);
    for (const c of run.candidates) if (c.status === 'running' || c.status === 'pending') {
      c.status = 'failed'; c.error = run.error;
    }
    snapshot();
  } finally { liveOptimizationRuns.delete(run.id); }
}

export function adoptOptimization(sessionId: string, runId: string, candidateId: string,
  expectedBaseRevisionId: string): string {
  const run = loadOptimization(sessionId, runId);
  if (expectedBaseRevisionId !== run.baseRevisionId) throw new Error('当前方案已切换，请回到本任务基线后采用');
  if (run.adopted) {
    if (run.adopted.candidateId !== candidateId) throw new Error('本任务已采用其他候选');
    return run.adopted.revisionId;
  }
  if (run.status !== 'completed') throw new Error('任务尚未完成');
  const candidate = run.candidates.find((c) => c.id === candidateId);
  if (!candidate?.modelHash || !candidate.evaluation
    || (candidate.status !== 'completed' && candidate.status !== 'rejected')) {
    throw new Error('该候选尚未完成试算，无法采用');
  }
  const current = readInputs(sessionId, run.baseRevisionId);
  if (hashValue(current.model) !== run.baseModelHash || hashValue(current.configs) !== run.scenarioHash) {
    throw new Error('基线模型或仿真设置已变化，请重新优化后采用');
  }
  const model = loadCandidateModel(run, candidateId);
  const lineage = candidate.lineage ?? [candidate.patch];
  if (hashValue(lineage.reduce((m, p) => applyDesignPatch(m, p), current.model)) !== candidate.modelHash) {
    throw new Error('候选不再匹配已验证的局部修改');
  }
  // It is a design derived from the sketch, not a new sketch extraction report.
  delete model.model.sketchId;
  delete model.model.sketchStatus;
  const saved = saveDesign(sessionId, model, run.baseRevisionId);
  const dir = path.join(workspacesDir, sessionId, 'designs', saved.revisionId);
  writeJson(path.join(dir, 'sunlight.json'), run.configs.sunlight);
  writeJson(path.join(dir, 'pedestrian.json'), run.configs.pedestrian);
  writeJson(path.join(dir, 'validation.json'), { valid: true, status: 'accepted', optimizationRunId: run.id });
  writeJson(path.join(dir, 'patch.json'), { lineage,
    baseRevisionId: run.baseRevisionId, baseModelHash: run.baseModelHash, optimizationRunId: run.id, candidateId });
  run.adopted = { candidateId, revisionId: saved.revisionId };
  saveOptimization(run);
  return saved.revisionId;
}
