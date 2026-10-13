import { parseResidentialBrief, type ResidentialBriefDocument } from '@sdd/shared';
import type { ResidentialBriefDraft } from './generation';

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}
const draftKey = (sessionId: string) => `sdd.residentialBriefDraft:${sessionId}`;

export function rememberResidentialDraft(storage: DraftStorage, sessionId: string, draft?: ResidentialBriefDraft) {
  if (draft?.dirty || draft?.layoutDirty) storage.setItem(draftKey(sessionId), JSON.stringify({
    brief: draft.brief, baseModelHash: '', version: draft.version, graphLayoutVersion: draft.graphLayoutVersion ?? 0, updatedAt: '',
  }));
}

/** Delete only the draft actually attached; newer local edits must survive the upload. */
export async function attachResidentialDraft(storage: DraftStorage, sessionId: string, revisionId: string,
  load: () => Promise<ResidentialBriefDocument>,
  save: (document: ResidentialBriefDocument, brief: ResidentialBriefDocument['brief']) => Promise<ResidentialBriefDocument>) {
  const key = draftKey(sessionId), raw = storage.getItem(key);
  if (!raw) return false;
  const draft = JSON.parse(raw) as ResidentialBriefDocument;
  const brief = { ...parseResidentialBrief(draft.brief), baseRevisionId: revisionId };
  const document = await load();
  await save(document, brief);
  if (storage.getItem(key) === raw) storage.removeItem(key);
  return true;
}
