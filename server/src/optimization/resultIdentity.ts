import { residentialBriefSemantics } from '@sdd/shared';
import fs from 'node:fs';
import path from 'node:path';
import { OPTIMIZATION_POLICY, RESIDENTIAL_SCENARIO, type OptimizationEvaluation, type OptimizationRun, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import { sunlightEngineId, pedestrianEngineId, workspacesDir } from '../config';
import { canonicalHash, createResultIdentity, identityModules, identityEngineVersionsMatch } from '../analysis/runtime/identity';
import { resolveOptimizationAnalysisPlan } from './analysisPlan';

export function optimizationResultIdentity(model: SpaceModel,
  run: Pick<OptimizationRun, 'sessionId' | 'baseRevisionId' | 'configs' | 'analysisPlan'>) {
  const file = path.join(workspacesDir, run.sessionId, 'designs', run.baseRevisionId, 'generation-brief.json');
  const document = model.model.residentialBrief && fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, 'utf8')) as ResidentialBriefDocument : undefined;
  if (model.model.residentialBrief && (!document || document.version !== model.model.residentialBrief.version
    || document.brief.baseRevisionId !== model.model.residentialBrief.baseRevisionId)) {
    throw new Error('住宅候选缺少匹配的冻结需求，不能确认评价身份');
  }
  const plan = resolveOptimizationAnalysisPlan(run);
  return createResultIdentity(model, {
    scope: { sessionId: run.sessionId, modelRevisionId: run.baseRevisionId },
    baseMap: document ? { id: document.brief.baseRevisionId, version: document.brief.baseRevisionId, contentHash: document.baseModelHash }
      : { id: run.baseRevisionId, version: run.baseRevisionId, contentHash: canonicalHash(model.model.dxfSource ?? model.floor) },
    requirements: document ? { id: 'residential-brief', version: String(document.version), contentHash: canonicalHash(residentialBriefSemantics(document.brief)) } : null,
    scenario: model.model.residentialBrief ? { id: RESIDENTIAL_SCENARIO.id, version: RESIDENTIAL_SCENARIO.version } : { id: 'generic-space', version: '1' },
    rules: { 'egress-sunlight-comparison': OPTIMIZATION_POLICY.version, policyParameters: canonicalHash(OPTIMIZATION_POLICY) },
    plan: { schemaVersion: plan.schemaVersion, version: '1' },
    modules: identityModules(plan, { sunlight: sunlightEngineId, pedestrian: pedestrianEngineId }),
  });
}

export function optimizationEvidenceMatchesIdentity(evaluation: OptimizationEvaluation): boolean {
  return identityEngineVersionsMatch(evaluation.identity,{sunlight:evaluation.sunlight.engineVersion,pedestrian:evaluation.pedestrian.engineVersion});
}
