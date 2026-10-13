import type { SpaceModel } from '@sdd/shared';

/** Candidate metadata chooses the frozen base; a base from another candidate cannot be reused. */
export async function resolveResidentialBase(model: SpaceModel, current: SpaceModel | undefined,
  load: (revisionId: string) => Promise<SpaceModel>): Promise<SpaceModel | undefined> {
  const reference = model.model.residentialBrief;
  if (reference) {
    const base = current?.model.revisionId === reference.baseRevisionId ? current : await load(reference.baseRevisionId);
    if (base.model.revisionId !== reference.baseRevisionId) throw new Error('住宅底图版本不匹配');
    return base;
  }
  return model.model.dxfSource && !model.spaces.length ? model : undefined;
}
