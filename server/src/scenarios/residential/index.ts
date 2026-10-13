import fs from 'node:fs';
import path from 'node:path';
import { RESIDENTIAL_SCENARIO, generationPrerequisites, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import type { PreparedScenarioGeneration, ScenarioRuntime } from '../types';
import { prepareResidentialGeneration, residentialGenerationMessage } from './residentialBrief';
import { runResidentialTurn } from './runResidentialTurn';
import { loadResidentialEvaluation, runResidentialEvaluation } from './residentialEvaluation';
import { residentialWorkspacePlan } from './analysisPlan';

/** Both legacy document callers and registered HTTP generation use the same scene implementation. */
export function prepareResidentialTurn(base: SpaceModel, document: ResidentialBriefDocument): PreparedScenarioGeneration {
  const frozenBase = structuredClone(base);
  const frozenDocument = structuredClone(document);
  return {
    definition: RESIDENTIAL_SCENARIO,
    base: frozenBase,
    message: residentialGenerationMessage(frozenDocument),
    missingInputs: generationPrerequisites(frozenBase, frozenDocument.brief, frozenDocument.version),
    async generate(context, adapter, emit, signal) {
      const folder = path.join(context.cwd, 'designs', context.revisionId);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify(RESIDENTIAL_SCENARIO, null, 2));
      return runResidentialTurn({ ...context, base: frozenBase, residentialBrief: frozenDocument }, adapter, emit, signal);
    },
  };
}

export const residentialScenario = {
  definition: RESIDENTIAL_SCENARIO,
  createAnalysisPlan: residentialWorkspacePlan,
  prepareGeneration(sessionId: string, raw: unknown) {
    const { model, document } = prepareResidentialGeneration(sessionId, raw);
    return prepareResidentialTurn(model, document);
  },
  loadEvaluation: loadResidentialEvaluation,
  runEvaluation: runResidentialEvaluation,
} satisfies ScenarioRuntime & {
  loadEvaluation: typeof loadResidentialEvaluation;
  runEvaluation: typeof runResidentialEvaluation;
  createAnalysisPlan: typeof residentialWorkspacePlan;
};
