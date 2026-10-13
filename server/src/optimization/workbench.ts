import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parsePedestrianConfig, parseSunlightConfig, type OptimizationSetup,
  type WorkbenchAnalysis, type WorkbenchAnalysisRequest, type OptimizationRun } from '@sdd/shared';
import { workspacesDir, sunlightEngineId, pedestrianEngineId } from '../config';
import { loadDesign } from '../model/store';
import { defaultAgents } from '../pedestrian/ensureConfig';
import { defaultSunlightTemplatePath } from '../sunlight/ensureConfig';
import { parseAutomaticOptimizationRequest } from './automatic';
import { loadAnalysis } from './comparison';
import { loadOptimizationBaseline, parseOptimizationRequest, prepareOptimization } from './run';
import { evaluateModel, type EvaluateModel } from './simulate';
import { optimizationAnalysisPlan } from './analysisPlan';
import { optimizationResultIdentity, optimizationEvidenceMatchesIdentity } from './resultIdentity';
import { sameCachedResult } from '../analysis/runtime/identity';
import { hashValue, validRevisionId, validSessionId, writeJson } from './store';

function designDir(sessionId: string, revisionId: string) {
  if (!validSessionId(sessionId) || !validRevisionId(revisionId)) throw new Error('无效方案');
  return path.join(workspacesDir, sessionId, 'designs', revisionId);
}

export function readOptimizationSetup(sessionId: string, revisionId: string): OptimizationSetup {
  const dir = designDir(sessionId, revisionId);
  const model = loadDesign(sessionId, revisionId);
  if (!model) throw new Error('方案不存在');
  const assumptions: string[] = [];
  let sunlight: unknown, pedestrian: unknown;
  if (fs.existsSync(path.join(dir, 'sunlight.json'))) sunlight = JSON.parse(fs.readFileSync(path.join(dir, 'sunlight.json'), 'utf8'));
  else {
    sunlight = { ...JSON.parse(fs.readFileSync(defaultSunlightTemplatePath(), 'utf8')), targets: undefined };
    assumptions.push('日照为试算预设：上海、冬至、08:00–16:00，模型上方为北。请按项目修改。');
  }
  if (fs.existsSync(path.join(dir, 'pedestrian.json'))) pedestrian = JSON.parse(fs.readFileSync(path.join(dir, 'pedestrian.json'), 'utf8'));
  else {
    pedestrian = { schemaVersion: '1', scenario: 'egress', model: 'collision-free', dt: 0.05,
      maxDurationSec: 300, seed: 1, agents: defaultAgents(model, { includeOpenSpaces: !!model.model.sketchId }) };
    assumptions.push('疏散人数按每 8 平方米约 1 人估算；用于试算，请核对实际人数。');
  }
  const sun = parseSunlightConfig(sunlight), ped = parsePedestrianConfig(pedestrian);
  if (!sun.ok) throw new Error(sun.errors.join('；'));
  if (!ped.ok) throw new Error(ped.errors.join('；'));
  return { modelHash: hashValue(model), configs: { sunlight: sun.config, pedestrian: ped.config }, assumptions };
}

export function parseWorkbenchAnalysisRequest(raw: unknown): WorkbenchAnalysisRequest {
  const base = parseAutomaticOptimizationRequest(raw);
  const value = raw as WorkbenchAnalysisRequest;
  if (value.confirmConditions !== true || typeof value.expectedModelHash !== 'string') throw new Error('请核对并确认本轮仿真条件');
  const sun = parseSunlightConfig(value.configs?.sunlight), ped = parsePedestrianConfig(value.configs?.pedestrian);
  if (!sun.ok) throw new Error(sun.errors.join('；'));
  if (!ped.ok) throw new Error(ped.errors.join('；'));
  return { ...base, expectedModelHash: value.expectedModelHash, confirmConditions: true,
    configs: { sunlight: sun.config, pedestrian: ped.config } };
}

function checkInputs(request: WorkbenchAnalysisRequest) {
  const model = loadOptimizationBaseline(request);
  if (hashValue(model) !== request.expectedModelHash) throw new Error('空间已变化，请重新核对任务和仿真条件');
  if (request.configs.pedestrian.model !== 'collision-free') throw new Error('当前仅支持 collision-free 疏散工况');
  if (request.configs.pedestrian.agents.some((agent) => !model.spaces.some((space) => space.id === agent.spaceId))) throw new Error('疏散人数引用了不存在的空间');
  const ids = new Set(model.spaces.flatMap((space) => [space.id, space.allocationId ?? space.id]));
  if (request.configs.sunlight.targets?.some((target) => target.spaceIds.some((id) => !ids.has(id)))) throw new Error('日照目标引用了不存在的空间');
  return model;
}

function saveConfigs(request: WorkbenchAnalysisRequest) {
  const dir = designDir(request.sessionId, request.revisionId);
  writeJson(path.join(dir, 'sunlight.json'), request.configs.sunlight);
  writeJson(path.join(dir, 'pedestrian.json'), request.configs.pedestrian);
}

export function prepareWorkbenchOptimization(raw: unknown) {
  const conditions = parseWorkbenchAnalysisRequest(raw);
  checkInputs(conditions);
  const prepared = prepareOptimization(parseOptimizationRequest(raw), conditions.configs);
  saveConfigs(conditions);
  const analysis = latestWorkbenchAnalysis(conditions.sessionId, conditions.revisionId);
  const baseline = analysis?.modelHash === prepared.run.baseModelHash && analysis.scenarioHash === prepared.run.scenarioHash
    && sameCachedResult(analysis.identity, optimizationResultIdentity(prepared.model, prepared.run))
    ? analysis.evaluation : undefined;
  return { ...prepared, baseline };
}

type SavedAnalysis = Omit<WorkbenchAnalysis, 'view'> & { engines: string[] };
const engines = () => [sunlightEngineId, pedestrianEngineId];

export async function analyzeWorkbench(request: WorkbenchAnalysisRequest, signal: AbortSignal,
  evaluate: EvaluateModel = evaluateModel): Promise<WorkbenchAnalysis> {
  const model = checkInputs(request);
  const scenarioHash = hashValue(request.configs);
  const cached = latestWorkbenchAnalysis(request.sessionId, request.revisionId);
  if (cached?.modelHash === request.expectedModelHash && cached.scenarioHash === scenarioHash) {
    saveConfigs(request); return cached;
  }
  signal.throwIfAborted();
  saveConfigs(request);
  const analysisPlan = optimizationAnalysisPlan(request.configs);
  const context = { sessionId: request.sessionId, baseRevisionId: request.revisionId, scenarioHash, configs: request.configs, analysisPlan };
  const identity = optimizationResultIdentity(model, context);
  const evaluation = { ...await evaluate(model, context, signal, () => {}), identity };
  signal.throwIfAborted();
  const view = loadAnalysis(context, evaluation, model);
  const record: SavedAnalysis = { id: randomUUID(), sessionId: request.sessionId, revisionId: request.revisionId,
    modelHash: hashValue(model), scenarioHash, createdAt: new Date().toISOString(), configs: request.configs, analysisPlan, identity, evaluation, engines: engines() };
  const dir = path.join(workspacesDir, request.sessionId, 'analyses', record.id);
  writeJson(path.join(dir, 'model.json'), model);
  writeJson(path.join(dir, 'analysis.json'), record);
  return { ...record, view };
}

export function latestWorkbenchAnalysis(sessionId: string, revisionId: string): WorkbenchAnalysis | null {
  designDir(sessionId, revisionId);
  const dir = path.join(workspacesDir, sessionId, 'analyses');
  if (!fs.existsSync(dir)) return null;
  const records = fs.readdirSync(dir).flatMap((id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return [];
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, id, 'analysis.json'), 'utf8')) as SavedAnalysis;
      return record.sessionId === sessionId && record.revisionId === revisionId && record.id === id ? [record] : [];
    } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const record of records) {
    try {
      if (hashValue(record.engines) !== hashValue(engines())) continue;
      const model = JSON.parse(fs.readFileSync(path.join(dir, record.id, 'model.json'), 'utf8'));
      if (hashValue(model) !== record.modelHash) continue;
      const context = { ...record, baseRevisionId: revisionId };
      const currentModel = loadDesign(sessionId, revisionId);
      if (!currentModel) continue;
      const currentConfigs = readOptimizationSetup(sessionId, revisionId).configs;
      const expectedIdentity = optimizationResultIdentity(currentModel, { ...context, configs: currentConfigs,
        analysisPlan: optimizationAnalysisPlan(currentConfigs) });
      if (!sameCachedResult(record.identity, expectedIdentity) || !sameCachedResult(record.evaluation.identity, expectedIdentity)
        || !optimizationEvidenceMatchesIdentity(record.evaluation)) continue;
      return { ...record, view: loadAnalysis(context, record.evaluation, model) };
    } catch { /* Incomplete or changed artifacts cannot be reused. */ }
  }
  return null;
}
