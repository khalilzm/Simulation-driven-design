import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { CanvasModule, ResidentialDaylightRecord, SpaceModel } from '@sdd/shared';
import { residentialEvaluation } from '../../api';
import type { ModelDisplayMode, ViewerContent } from '../../types';
import { createRequestScope } from '../../workbench/requestScope';

export function useResidentialEvaluation({ sessionId, revisionId, model, setViewerContent,
  setViewerDisplay, setViewer3d, setFocusedModule, setNotice }: {
  sessionId?: string; revisionId?: string; model?: SpaceModel;
  setViewerContent: Dispatch<SetStateAction<ViewerContent>>;
  setViewerDisplay: Dispatch<SetStateAction<ModelDisplayMode>>;
  setViewer3d: Dispatch<SetStateAction<boolean>>;
  setFocusedModule: Dispatch<SetStateAction<CanvasModule | null>>;
  setNotice: Dispatch<SetStateAction<string | undefined>>;
}) {
  const key = JSON.stringify([sessionId, revisionId]);
  const scope = useRef(createRequestScope()).current;
  scope.setContext(key);
  const scopedModel = useRef(model);
  if (scopedModel.current !== model) { scope.invalidateAll(); scopedModel.current = model; }
  const [stored, setStored] = useState<{ key: string; model?: SpaceModel; record: ResidentialDaylightRecord | null }>();
  const [evaluationRunning, setEvaluationRunning] = useState(false);
  const residentialAbort = useRef<AbortController>();
  const visibleEvaluation = stored?.key === key && stored.model === model ? stored.record : undefined;

  const applyResult = (record: ResidentialDaylightRecord | null) => {
    if (record?.revisionId !== revisionId && record !== null) return;
    setStored({ key, model, record });
    setViewerContent(content => {
      if (content.kind !== 'model' || content.model.model.revisionId !== revisionId) return content;
      if (record?.status === 'stale') return { ...content, daylight: undefined };
      if (record?.status === 'completed' && record.result) return { ...content, daylight: record.result };
      return content;
    });
  };

  useEffect(() => {
    residentialAbort.current?.abort(new Error('评价对象已切换'));
    residentialAbort.current = undefined;
    setEvaluationRunning(false);
    return () => {
      residentialAbort.current?.abort();
      residentialAbort.current = undefined;
      scope.invalidateAll();
    };
  }, [key, model, scope]);

  useEffect(() => {
    if (!sessionId || !revisionId || !model?.model.residentialBrief) return;
    const token = scope.begin('load');
    void residentialEvaluation(sessionId, revisionId).then(record => {
      if (!scope.isCurrent(token)) return;
      setStored(previous => record?.status !== 'stale' && previous?.key === key && previous.model === model
        && previous.record?.status === 'completed' ? previous : { key, model, record });
      setViewerContent(content => {
        if (content.kind !== 'model' || content.model.model.revisionId !== revisionId) return content;
        if (record?.status === 'stale') return { ...content, daylight: undefined };
        if (record?.status === 'completed' && record.result) return { ...content, daylight: record.result };
        return content;
      });
    }).catch(error => { if (scope.isCurrent(token)) setNotice(error instanceof Error ? error.message : String(error)); });
    return () => scope.invalidate('load');
  }, [sessionId, revisionId, model, key, scope, setNotice, setViewerContent]);

  const handleEvaluateResidential = async () => {
    if (!sessionId || !revisionId || residentialAbort.current) return;
    if (visibleEvaluation?.status === 'completed') {
      setViewerDisplay('daylight'); setFocusedModule('scheme'); return;
    }
    const controller = new AbortController();
    residentialAbort.current = controller;
    scope.invalidate('load');
    const token = scope.begin('run');
    setEvaluationRunning(true);
    setNotice('几何候选已保留，正在计算室内采光并评价房间面积比例…');
    const timer = setTimeout(() => controller.abort(new Error('采光评价超时')), 210000);
    try {
      const record = await residentialEvaluation(sessionId, revisionId, true, controller.signal);
      if (!scope.isCurrent(token)) return;
      applyResult(record);
      if (record?.status === 'completed') {
        setViewerDisplay('daylight'); setViewer3d(false);
        setNotice('采光计算完成，查看房间评价和热力图；未达标目标不会自动降低。');
      } else setNotice(record?.error ?? '采光评价未完成，几何候选已保留');
    } catch (error) {
      if (!scope.isCurrent(token)) return;
      setNotice(controller.signal.aborted ? '采光评价已取消，几何候选已保留' : error instanceof Error ? error.message : String(error));
      void residentialEvaluation(sessionId, revisionId).then(record => {
        if (scope.isCurrent(token)) applyResult(record);
      }).catch(() => {});
    } finally {
      clearTimeout(timer);
      if (residentialAbort.current === controller) {
        residentialAbort.current = undefined;
        setEvaluationRunning(false);
      }
    }
  };
  return { visibleEvaluation, evaluationRunning, residentialAbort, handleEvaluateResidential };
}
