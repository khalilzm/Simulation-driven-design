import { RESIDENTIAL_SCENARIO, briefTurnReply, generationPrerequisites, revealedBriefBoards, nextResidentialBriefDocument, residentialBriefSemantics, residentialGraphLayout, residentialBriefWithLayout,
  type BriefBoard, type ResidentialBrief, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import type { PreparedScenarioGeneration } from '../../workbench/scenarioGeneration';

export interface ResidentialBriefDraft { brief: ResidentialBrief; version: number; dirty: boolean; graphLayoutVersion?: number; layoutDirty?: boolean }
export interface ResidentialBriefServices {
  load: (revisionId: string) => Promise<ResidentialBriefDocument>;
  save: (document: ResidentialBriefDocument, brief: ResidentialBrief) => Promise<ResidentialBriefDocument>;
  interpret: (module: BriefBoard, brief: ResidentialBrief) => Promise<{ brief: ResidentialBrief }>;
  saveLocal: (document: ResidentialBriefDocument) => void;
  assertActive: () => void;
}

export function residentialGenerationRequest(document: ResidentialBriefDocument) {
  return { id: RESIDENTIAL_SCENARIO.id, version: RESIDENTIAL_SCENARIO.version,
    input: { baseRevisionId: document.brief.baseRevisionId, version: document.version, baseModelHash: document.baseModelHash } };
}

/** Successful graph work survives a later metrics failure; no empty artifact is announced. */
export async function interpretResidentialTurn(modules: readonly BriefBoard[], initial: ResidentialBrief,
  version: number, base: SpaceModel | undefined, services: ResidentialBriefServices, previous?: ResidentialBriefDocument) {
  let brief = initial, failure: string | undefined;
  const completed: BriefBoard[] = [];
  for (const module of modules) {
    services.assertActive();
    if (module === 'metrics' && !brief.rooms.length) break;
    try {
      const result = await services.interpret(module, brief);
      services.assertActive(); brief = result.brief; completed.push(module);
    } catch (error) {
      services.assertActive(); failure = error instanceof Error ? error.message : String(error); break;
    }
  }
  services.assertActive();
  if (!completed.length) throw new Error(failure ?? 'Agent 整理需求失败');
  const boards = revealedBriefBoards(completed, brief);
  let document: ResidentialBriefDocument | undefined;
  if (boards.length) {
    if (base) {
      const current = await services.load(base.model.revisionId); services.assertActive();
      if (current.version !== version) throw new Error('需求版本已变化，请重新加载后再保存');
      if (previous && (current.graphLayoutVersion ?? 0) !== (previous.graphLayoutVersion ?? 0)) {
        const interpreted = residentialGraphLayout(brief), latest = residentialGraphLayout(current.brief);
        brief = residentialBriefWithLayout(residentialBriefSemantics(brief), {
          positions: { ...interpreted.positions, ...latest.positions }, handles: { ...interpreted.handles, ...latest.handles },
        });
      }
      document = await services.save(current, brief); services.assertActive();
    } else {
      document = nextResidentialBriefDocument(previous ?? { brief: initial, baseModelHash: '', version, updatedAt: '' }, brief);
      services.assertActive(); services.saveLocal(document);
    }
  }
  return { document, boards, reply: [briefTurnReply(failure ? completed : modules, boards), failure].filter(Boolean).join('\n') };
}

export async function prepareResidentialGeneration(sessionId: string | undefined, base: SpaceModel | undefined,
  draft: ResidentialBriefDraft | undefined, load: ResidentialBriefServices['load'], assertActive: () => void
): Promise<PreparedScenarioGeneration> {
  const missing = generationPrerequisites(base, draft?.brief, draft?.version, draft?.dirty);
  if (!sessionId || missing.length) throw new Error('生成输入尚未就绪');
  const document = await load(base!.model.revisionId); assertActive();
  if (document.version !== draft?.version || document.brief.baseRevisionId !== base!.model.revisionId)
    throw new Error('需求版本已变化，请重新加载并确认');
  return { mode: 'edit', parentRevisionId: document.brief.baseRevisionId, scenario: residentialGenerationRequest(document) };
}
