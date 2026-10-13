import { residentialBriefSemantics } from '@sdd/shared';
import { RESIDENTIAL_SCENARIO, type AnalysisPlan, type DaylightConfig, type ResidentialBriefDocument,
  type SpaceModel, type SunlightConfig } from '@sdd/shared';
import { canonicalHash, createResultIdentity, identityModules } from '../../analysis/runtime/identity';

export function residentialEvaluationIdentity(sessionId: string, revisionId: string, model: SpaceModel,
  document: ResidentialBriefDocument, capability: 'daylight' | 'sunlight', config: DaylightConfig | SunlightConfig, engineVersion: string) {
  const plan: AnalysisPlan = capability === 'daylight'
    ? { schemaVersion: '1', steps: [{ capability, config: config as DaylightConfig }] }
    : { schemaVersion: '1', steps: [{ capability, config: config as SunlightConfig }] };
  return createResultIdentity(model, {
    scope: { sessionId, modelRevisionId: revisionId },
    baseMap: { id: document.brief.baseRevisionId, version: document.brief.baseRevisionId, contentHash: document.baseModelHash },
    requirements: { id: 'residential-brief', version: String(document.version), contentHash: canonicalHash(residentialBriefSemantics(document.brief)) },
    scenario: { id: RESIDENTIAL_SCENARIO.id, version: RESIDENTIAL_SCENARIO.version },
    rules: { [capability === 'daylight' ? 'residential-daylight' : 'residential-direct-sun']: capability === 'daylight' ? '1' : '2' },
    plan: { schemaVersion: plan.schemaVersion, version: '1' }, modules: identityModules(plan, { [capability]: engineVersion }),
  });
}
