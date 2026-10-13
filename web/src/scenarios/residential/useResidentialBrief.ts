import { rememberResidentialDraft, attachResidentialDraft } from './draftStorage';
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { parseResidentialBrief, nextResidentialBriefDocument, createResidentialBrief, residentialBriefChanges, type ResidentialBrief, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import { loadResidentialBrief, saveResidentialBrief } from '../../api';
import type { ResidentialBriefDraft } from './generation';
import { createRequestScope } from '../../workbench/requestScope';

export function useResidentialBrief(sessionId: string | undefined, setNotice: Dispatch<SetStateAction<string | undefined>>) {
  const [briefDraft, setBriefDraft] = useState<ResidentialBriefDraft>();
  const [briefBaseModel, setBriefBaseModel] = useState<SpaceModel>();
  const [solverReportRevision, setSolverReportRevision] = useState<string>();
  const scope = useRef(createRequestScope()).current;
  scope.setContext(JSON.stringify([sessionId, briefBaseModel?.model.revisionId]));
  useEffect(() => () => scope.invalidateAll(), [scope]);
  useEffect(() => { setSolverReportRevision(undefined); }, [sessionId, briefBaseModel?.model.revisionId]);
  const onBriefChange = useCallback((brief: ResidentialBrief, version: number, dirty: boolean, layout?: { graphLayoutVersion: number; layoutDirty: boolean }) => setBriefDraft({ brief, version, dirty, ...layout }), []);
  useEffect(() => {
    setBriefDraft(undefined);
    if (!sessionId) return;
    if (!briefBaseModel) {
      try {
        const saved = localStorage.getItem(`sdd.residentialBriefDraft:${sessionId}`);
        if (saved) {
          const draft = JSON.parse(saved) as ResidentialBriefDocument;
          setBriefDraft({ brief: parseResidentialBrief(draft.brief), version: draft.version, dirty: false, graphLayoutVersion: draft.graphLayoutVersion ?? 0, layoutDirty: false });
        }
      } catch { /* An invalid local draft must not block the workspace. */ }
      return;
    }
    let cancelled = false;
    void loadResidentialBrief(sessionId, briefBaseModel.model.revisionId).then(document => {
      if (!cancelled) setBriefDraft({ brief: document.brief, version: document.version, dirty: false, graphLayoutVersion: document.graphLayoutVersion ?? 0, layoutDirty: false });
    }).catch(error => { if (!cancelled) setNotice(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [sessionId, briefBaseModel?.model.revisionId, setNotice]);

  const saveBriefDraft = async () => {
    if (!sessionId || !briefDraft || (!briefDraft.dirty && !briefDraft.layoutDirty)) return;
    const token = scope.begin('save');
    try {
      if (!briefBaseModel) {
        const raw = localStorage.getItem(`sdd.residentialBriefDraft:${sessionId}`);
        const previous: ResidentialBriefDocument = raw ? JSON.parse(raw) : { brief: createResidentialBrief(briefDraft.brief.baseRevisionId), baseModelHash: '', version: 0, updatedAt: '' };
        const saved = nextResidentialBriefDocument(previous, briefDraft.brief);
        localStorage.setItem(`sdd.residentialBriefDraft:${sessionId}`, JSON.stringify(saved));
        setBriefDraft({ ...briefDraft, version: saved.version, dirty: false, graphLayoutVersion: saved.graphLayoutVersion ?? 0, layoutDirty: false });
        setNotice('仿真指标已保存到本地草稿；上传 DXF 后可关联到底图');
      } else {
        const current = await loadResidentialBrief(sessionId, briefBaseModel.model.revisionId);
        if (!scope.isCurrent(token)) return;
        if (current.version !== briefDraft.version || (current.graphLayoutVersion ?? 0) !== (briefDraft.graphLayoutVersion ?? 0))
          throw new Error('需求或节点图布局已变化，请重新加载后再保存');
        const saved = await saveResidentialBrief(sessionId, current, briefDraft.brief);
        if (!scope.isCurrent(token)) return;
        setBriefDraft(current => current && current.brief !== briefDraft.brief
          ? { ...current, version: saved.version, graphLayoutVersion: saved.graphLayoutVersion ?? 0, dirty: residentialBriefChanges(saved.brief, current.brief).semantic, layoutDirty: residentialBriefChanges(saved.brief, current.brief).layout }
          : { brief: saved.brief, version: saved.version, dirty: false, graphLayoutVersion: saved.graphLayoutVersion ?? 0, layoutDirty: false });
        setNotice(`仿真指标已保存到需求版本 ${saved.version}`);
      }
    } catch (error) { if (scope.isCurrent(token)) setNotice(error instanceof Error ? error.message : String(error)); }
  };

  const updateMetricsBrief = (brief: ResidentialBrief) => setBriefDraft(current => current
    ? { ...current, brief, dirty: true }
    : { brief, version: 0, dirty: true });

  const rememberDraftForUpload = (sid: string) => {
    try { rememberResidentialDraft(localStorage, sid, briefDraft); } catch { /* Optional browser storage. */ }
  };
  const attachDraftToBase = async (sid: string, revisionId: string) => {
    try {
      return await attachResidentialDraft(localStorage, sid, revisionId,
        () => loadResidentialBrief(sid, revisionId),
        (document, brief) => saveResidentialBrief(sid, document, brief));
    } catch { return false; /* Keep the draft if parsing, loading or saving fails. */ }
  };

  return { rememberDraftForUpload, attachDraftToBase, briefDraft, setBriefDraft, briefBaseModel, setBriefBaseModel, solverReportRevision, setSolverReportRevision, onBriefChange, saveBriefDraft, updateMetricsBrief };
}
