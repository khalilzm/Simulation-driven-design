import { resolveResidentialBase } from './scenarios/residential/baseModel';
import { useResidentialGeneration } from './scenarios/residential/useResidentialGeneration';
import { useResidentialBrief } from './scenarios/residential/useResidentialBrief';
import { useResidentialEvaluation } from './scenarios/residential/useResidentialEvaluation';
import { ResidentialEvaluationPanel, ResidentialMetricsEditor, ResidentialSolverReport } from './scenarios/residential';
import { lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasModule, OptimizationComparison, OptimizationSetup, ProviderId, SketchReport, SpaceTaskMode, SpaceModel } from '@sdd/shared';
import { CANVAS_MODULES, MODULE_TITLES, generationPrerequisites, roomDaylight, SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import {
  adoptOptimization,
  fetchStatus,
  generate,
  listDesigns,
  loadDesign,
  loadOptimizationSetup,
  savePedestrianConfig,
  saveSunlightConfig,
  streamChat,
  uploadSketch,
  uploadDxf,
  loadSketchReport,
} from './api';
import type { DesignSummary } from './api';
import { chatImageFromInputPath } from './chatImages';
import type { ProviderOption } from './components/ProviderSelect';
import { ProviderSelect } from './components/ProviderSelect';
import { Chat } from './components/Chat';
import { ChatDropZone } from './components/ChatDropZone';
import { Composer } from './components/Composer';
import { DesignWorkbench } from './components/DesignWorkbench';
import { GraphPreview, PlanPreview } from './components/ModulePreviews';
import type { ModulePresentation } from './components/DesignCanvas';
import { Upload } from './components/Upload';
import type { ChatMessage, ModelDisplayMode, ViewerContent } from './types';
const Viewer = lazy(() => import('./viewer/Viewer').then(module => ({ default: module.Viewer })));
const SpaceNodeEditor = lazy(() => import('./scenarios/residential/SpaceNodeEditor').then(module => ({ default: module.SpaceNodeEditor })));
const SimulationWorkspace = lazy(() => import('./components/SimulationWorkspace').then(module => ({ default: module.SimulationWorkspace })));
const OptimizationComparisonView = lazy(() => import('./components/OptimizationComparisonView').then(module => ({ default: module.OptimizationComparisonView })));

export default function App() {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderId>('codex');
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [optimizationBusy, setOptimizationBusy] = useState(false);
  const [viewerContent, setViewerContent] = useState<ViewerContent>({ kind: 'empty' });
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [currentRevisionId, setCurrentRevisionId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [taskMode, setTaskMode] = useState<SpaceTaskMode>('generate');
  const [selectedSketchId, setSelectedSketchId] = useState<string>();
  const [sketchReport, setSketchReport] = useState<SketchReport>();
  const [viewerDisplay, setViewerDisplay] = useState<ModelDisplayMode>('usage');
  const [viewer3d, setViewer3d] = useState(false);
  const [comparison, setComparison] = useState<OptimizationComparison | null>(null);
  const [focusedModule, setFocusedModule] = useState<CanvasModule | null>(null);
  const [activeBoards, setActiveBoards] = useState<Set<CanvasModule>>(new Set());
  const [referenceModule, setReferenceModule] = useState<CanvasModule | null>(null);
  const [adoptedRevisionId, setAdoptedRevisionId] = useState<string>();
  const [simSetup, setSimSetup] = useState<OptimizationSetup | null>(null);
  const [focusSpaceId, setFocusSpaceId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatScrollTick, setChatScrollTick] = useState(0);
  const chatScrollRef = useRef(0);
  const chatAbort = useRef<AbortController>();
  useEffect(() => () => { chatAbort.current?.abort(); }, []);

  const model = viewerContent.kind === 'model' ? viewerContent.model : undefined;
  const activeSession = useRef(sessionId); activeSession.current = sessionId;
  const designLoadSequence = useRef(0);
  const resetViewerToPlan = () => {
    setViewerDisplay('usage');
    setViewer3d(false);
  };

  const handleViewerDisplayChange = (mode: ModelDisplayMode) => {
    setViewerDisplay(mode);
    setViewer3d(false);
    setFocusSpaceId(null);
  };

  const handleFocusSpace = (spaceId: string) => {
    setViewerDisplay('usage');
    setViewer3d(false);
    setFocusSpaceId(spaceId);
  };

  const { rememberDraftForUpload, attachDraftToBase, briefDraft, setBriefDraft, briefBaseModel, setBriefBaseModel, solverReportRevision,
    setSolverReportRevision, onBriefChange, saveBriefDraft, updateMetricsBrief } = useResidentialBrief(sessionId, setNotice);
  const { visibleEvaluation, evaluationRunning, residentialAbort, handleEvaluateResidential } = useResidentialEvaluation({
    sessionId, revisionId: currentRevisionId, model, setViewerContent, setViewerDisplay, setViewer3d, setFocusedModule, setNotice,
  });
  const appBusy = busy || optimizationBusy || evaluationRunning;

  useEffect(() => {
    fetchStatus()
      .then((s) => setProviders(s.providers))
      .catch((e) => console.error('无法获取提供方状态', e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const raw = localStorage.getItem('sdd.workbench') ?? localStorage.getItem('sdd.fixedEnvelope');
      if (raw) {
        const saved = JSON.parse(raw) as { sessionId: string; revisionId?: string; baseRevisionId?: string; provider: ProviderId; adoptedRevisionId?: string };
        const restore = async () => {
          const [loaded, versions] = await Promise.all([
            saved.revisionId ? loadDesign(saved.sessionId,saved.revisionId) : Promise.resolve(undefined),
            listDesigns(saved.sessionId),
          ]);
          const savedBase = saved.baseRevisionId ? await loadDesign(saved.sessionId, saved.baseRevisionId) : undefined;
          const base = loaded ? await resolveResidentialBase(loaded, savedBase, revision => loadDesign(saved.sessionId, revision)) : savedBase;
          if (cancelled) return;
          const restored = loaded?.model.residentialBrief && loaded.model.residentialBrief.baseRevisionId === base?.model.revisionId && loaded.model.residentialBrief.version > 0 ? loaded : base;
          setSessionId(saved.sessionId); setProvider(saved.provider); setCurrentRevisionId(restored?.model.revisionId);
          setAdoptedRevisionId(saved.adoptedRevisionId);
          setBriefBaseModel(base); setViewerContent(restored ? {kind:'model',model:restored} : {kind:'empty'}); setDesigns(versions); setTaskMode(restored ? 'edit' : 'generate');
          setNotice('已恢复工作区');
        };
        void restore().catch(() => { /* A removed workspace need not block a fresh upload. */ });
      }
    } catch { /* Browser storage is optional. */ }
    return () => {cancelled=true;};
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    try { localStorage.setItem('sdd.workbench', JSON.stringify({ sessionId, revisionId: currentRevisionId, baseRevisionId: briefBaseModel?.model.revisionId, provider, adoptedRevisionId })); } catch { /* optional browser cache */ }
  }, [sessionId, currentRevisionId, briefBaseModel?.model.revisionId, provider, adoptedRevisionId]);

  useEffect(() => {
    setFocusSpaceId(null);
  }, [currentRevisionId]);

  useEffect(() => {
    const sid = sessionId;
    const rev = currentRevisionId;
    if (!sid || !rev || !model?.spaces.length) {
      setSimSetup(null);
      return;
    }
    const abort = new AbortController();
    loadOptimizationSetup(sid, rev, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setSimSetup(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setNotice(error instanceof Error ? error.message : String(error));
      });
    return () => abort.abort();
  }, [sessionId, currentRevisionId, model?.spaces.length]);

  const handleProviderChange = (p: ProviderId) => {
    activeSession.current = undefined;
    setProvider(p);
    setSessionId(undefined);
    setMessages([]);
    setDesigns([]);
    setCurrentRevisionId(undefined);
    setViewerContent({ kind: 'empty' });
    resetViewerToPlan();
    setSelectedSketchId(undefined);
    setSketchReport(undefined);
    setComparison(null);
    setSimSetup(null);
    setTaskMode('generate');
    setFocusedModule(null); setReferenceModule(null); setAdoptedRevisionId(undefined);
    setActiveBoards(new Set());
    designLoadSequence.current += 1;
    setBriefBaseModel(undefined); setBriefDraft(undefined);
    try { localStorage.removeItem('sdd.fixedEnvelope'); localStorage.removeItem('sdd.workbench'); } catch { /* optional storage */ }
  };

  const openSimulation = () => {
    if (!model || !sessionId || !currentRevisionId) {
      setNotice('请先上传 DXF、还原草图或加载示例方案');
      return;
    }
    if (!activeBoards.has('metrics')) {
      setNotice('请在 Agent 对话中描述仿真目标，生成指标白板后再评价方案');
      setChatOpen(true);
      return;
    }
    setFocusedModule('metrics');
  };

  const ensureSessionId = (): string => {
    const sid = sessionId ?? crypto.randomUUID();
    if (!sessionId) { activeSession.current = sid; setSessionId(sid); }
    return sid;
  };

  const openModule = (module: CanvasModule) => {
    if (activeBoards.has(module)) setFocusedModule(module);
  };

  const bumpChatScroll = () => {
    chatScrollRef.current += 1;
    setChatScrollTick(chatScrollRef.current);
  };

  const { prepareMessage: prepareResidentialMessage } = useResidentialGeneration({
    sessionId, provider, base: briefBaseModel, draft: briefDraft, ensureSessionId,
    onBriefChange, setMessages, setBoards: setActiveBoards, setNotice, setBusy,
    scroll: bumpChatScroll, abortRef: chatAbort,
  });

  const showSketchReport = async (sid: string, revisionId: string) => {
    const report = await loadSketchReport(sid, revisionId);
    setSketchReport(report);
    setSelectedSketchId(report.source.id);
    setTaskMode('sketch');
    setCurrentRevisionId(revisionId);
    setComparison(null);
    resetViewerToPlan();
    if (report.geometryValid && report.model) {
      setViewerContent({ kind: 'model', model: report.model });
    } else {
      setViewerContent({ kind: 'empty' });
      setFocusedModule('scheme'); setBriefBaseModel(undefined);
    }
    setDesigns(await listDesigns(sid));
  };

  const handleUploadFile = async (name: string, base64: string) => {
    setBusy(true);
    setNotice('上传中…');
    try {
      const sid = ensureSessionId();
      const res = await uploadSketch(sid, name, base64);
      setSessionId(res.sessionId);
      setCurrentRevisionId(undefined);
      setSelectedSketchId(res.sketch.id);
      setTaskMode('sketch');
      setSketchReport(undefined);
      setComparison(null);
      setSimSetup(null);
      setViewerContent({ kind: 'empty' });
      setFocusedModule(null);
      const image = chatImageFromInputPath(res.sessionId, res.file.name);
      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: 'user', content: '', images: [image] },
      ]);
      bumpChatScroll();
      setNotice(`已上传草图 ${name}；点击「还原草图」开始解析`);
    } catch (err) {
      setNotice(`上传失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadDxf = async (name: string, base64: string) => {
    setBusy(true);
    setNotice('正在解析 DXF 固定轮廓与构件…');
    try {
      const sid = ensureSessionId();
      rememberDraftForUpload(sid);
      const result = await uploadDxf(sid, name, base64);
      const draftAttached = await attachDraftToBase(result.sessionId, result.revisionId);
      setSessionId(result.sessionId);
      setCurrentRevisionId(result.revisionId);
      setSelectedSketchId(undefined);
      setSketchReport(undefined);
      setComparison(null);
      setSimSetup(null);
      setTaskMode('edit');
      setFocusedModule(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model: result.model });
      setBriefDraft(undefined); setAdoptedRevisionId(undefined);
      setBriefBaseModel(result.model); setActiveBoards(current => new Set([...current, 'dxf']));
      try { localStorage.setItem('sdd.fixedEnvelope',JSON.stringify({sessionId:result.sessionId,revisionId:result.revisionId,provider})); } catch { /* optional storage */ }
      setDesigns(await listDesigns(result.sessionId));
      const source = result.model.model.dxfSource!;
      const summary = `已导入 ${name}：轮廓 ${source.areaM2.toFixed(2)} ㎡，承重墙 ${source.counts.loadBearingWalls} 段，入户 ${source.counts.entrances} 处，窗洞 ${source.counts.windows} 处。`;
      setMessages((previous) => [...previous, { id: crypto.randomUUID(), role: 'user', content: `上传住宅底图：${name}`, ephemeral: true },
        { id: crypto.randomUUID(), role: 'assistant', content: `${summary}\n固定底图已显示，可切换 3D 检查。${source.warnings.length ? `\n${source.warnings.join('\n')}` : ''}`, artifact: { module: 'dxf' }, ephemeral: true }]);
      bumpChatScroll();
      setNotice(draftAttached ? `${summary} 已将本地空间节点草稿关联到底图。` : summary);
    } catch (error) {
      setNotice(`DXF 上传失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  };

  const handleRestoreSketch = async () => {
    const sid = ensureSessionId();
    const assistantId = crypto.randomUUID();
    setMessages((m) => [...m, { id: assistantId, role: 'assistant', content: '', status: 'thinking' }]);
    bumpChatScroll();
    setBusy(true);
    setNotice('还原草图中…');
    let sketchRevision: string | undefined;
    let generationFailed = false;
    const patch = (fn: (x: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((x) => (x.id === assistantId ? fn(x) : x)));
    try {
      await generate(
        sid,
        provider,
        (e) => {
          if (e.type === 'sketchReview') sketchRevision = e.revisionId;
          if (e.type === 'progress') {
            setNotice(e.message);
            patch((x) => ({ ...x, progress: e.message }));
          }
          if (e.type === 'text') patch((x) => ({ ...x, content: x.content + e.text }));
          if (e.type === 'thinking') patch((x) => ({ ...x, thinking: (x.thinking ?? '') + e.text }));
          if (e.type === 'sketchPreview') {
            const image = chatImageFromInputPath(sid, e.path);
            patch((x) => ({ ...x, images: [...(x.images ?? []), image] }));
            bumpChatScroll();
          }
          if (e.type === 'error') {
            patch((x) => ({
              ...x,
              content: x.content ? `${x.content}\n[错误] ${e.message}` : `[错误] ${e.message}`,
              status: 'failed',
            }));
          }
          if (e.type === 'done') {
            generationFailed = e.status === 'failed';
            patch((x) => ({
              ...x,
              status: e.status === 'failed' ? 'failed' : 'done',
              progress: undefined,
            }));
            bumpChatScroll();
          }
        },
        null,
        { mode: 'sketch', sketchId: selectedSketchId },
      );
      if (sketchRevision) {
        await showSketchReport(sid, sketchRevision);
        if (!generationFailed) { setActiveBoards(current => new Set([...current, 'scheme'])); setFocusedModule('scheme'); }
        setNotice(
          generationFailed
            ? '草图存在需修正的问题，请根据对话说明重新上传或修正'
            : '草图还原完成；点击「仿真优化」进入工作区并设定工况',
        );
        return;
      }
      setNotice('未生成草图结果，请检查输入');
    } catch (err) {
      patch((x) => ({
        ...x,
        content: err instanceof Error ? err.message : String(err),
        status: 'failed',
      }));
      setNotice(`还原失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectDesign = async (revisionId: string) => {
    const sid = sessionId;
    if (!sid) return;
    const sequence = ++designLoadSequence.current;
    setBusy(true);
    try {
      if (designs.find((d) => d.revisionId === revisionId)?.sketchId) {
        await showSketchReport(sid, revisionId);
        return;
      }
      setSketchReport(undefined);
      setTaskMode('edit');
      const loaded = await loadDesign(sid, revisionId);
      if (sequence !== designLoadSequence.current || activeSession.current !== sid) return;
      const base = await resolveResidentialBase(loaded, briefBaseModel, revision => loadDesign(sid, revision));
      if (sequence !== designLoadSequence.current || activeSession.current !== sid) return;
      setBriefBaseModel(base);
      setCurrentRevisionId(revisionId);
      setComparison(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model: loaded });
    } catch (err) {
      if (sequence === designLoadSequence.current && activeSession.current === sid)
        setNotice(`读取方案失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sequence === designLoadSequence.current && activeSession.current === sid) setBusy(false);
    }
  };

  const handleSend = async (message: string) => {
    if (appBusy) return;
    const preparation = taskMode === 'sketch' ? undefined : await prepareResidentialMessage(message);
    if (preparation?.kind === 'handled') return;
    const prepared = preparation?.generation;
    const controller = new AbortController(); chatAbort.current = controller;
    const assistantId = crypto.randomUUID();
    setMessages((m) => [
      ...m,
      { id: crypto.randomUUID(), role: 'user', content: message },
      { id: assistantId, role: 'assistant', content: '', status: 'thinking' },
    ]);
    bumpChatScroll();
    setBusy(true);
    const patch = (fn: (x: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((x) => (x.id === assistantId ? fn(x) : x)));
    let sid = sessionId;
    const mode = prepared?.mode ?? taskMode;
    try {
      await streamChat(
        {
          provider,
          sessionId,
          message: referenceModule ? `${message}\n\n[工作区引用]\n模块：${MODULE_TITLES[referenceModule]}\n方案版本：${currentRevisionId ?? '尚未生成'}${focusSpaceId ? `\n空间标识：${focusSpaceId}` : ''}` : message,
          parentRevisionId: prepared?.parentRevisionId ?? (mode === 'generate' ? null : currentRevisionId ?? null),
          requirePreparedInputs: true,
          scenario: prepared?.scenario,
          mode,
          sketchId: selectedSketchId,
        },
        (e) => {
          switch (e.type) {
            case 'session':
              sid = e.sessionId;
              activeSession.current = e.sessionId;
              setSessionId(e.sessionId);
              break;
            case 'text':
              patch((x) => ({ ...x, content: x.content + e.text }));
              break;
            case 'thinking':
              patch((x) => ({ ...x, thinking: (x.thinking ?? '') + e.text }));
              break;
            case 'progress':
              patch((x) => ({ ...x, progress: e.message }));
              break;
            case 'sketchPreview': {
              if (!sid) break;
              const image = chatImageFromInputPath(sid, e.path);
              patch((x) => ({ ...x, images: [...(x.images ?? []), image] }));
              bumpChatScroll();
              break;
            }
            case 'sketchReview':
              if (sid) void showSketchReport(sid, e.revisionId).catch((error) => setNotice(String(error)));
              break;
            case 'design': {
              if (!sid || mode === 'sketch') break;
              if (!e.valid) {
                patch((x) => ({ ...x, progress: e.errors.join('；') }));
                break;
              }
              const sidNow = sid;
              const sequence = ++designLoadSequence.current;
              setCurrentRevisionId(e.revisionId);
              setTaskMode('edit');
              setActiveBoards(current => new Set([...current, 'scheme']));
              patch(x => ({ ...x, artifact: { module: 'scheme', revisionId: e.revisionId } }));
              void loadDesign(sidNow, e.revisionId)
                .then((loaded) => {
                  if (designLoadSequence.current !== sequence || activeSession.current !== sidNow) return;
                  setViewerContent({ kind: 'model', model: loaded });
                  void resolveResidentialBase(loaded, briefBaseModel, revision => loadDesign(sidNow, revision)).then(base => {
                    if (designLoadSequence.current === sequence && activeSession.current === sidNow) setBriefBaseModel(base);
                  }).catch(error => { if (designLoadSequence.current === sequence && activeSession.current === sidNow) setNotice(String(error)); });
                  return listDesigns(sidNow);
                })
                .then(versions => { if (versions && designLoadSequence.current === sequence && activeSession.current === sidNow) setDesigns(versions); })
                .catch(error => setNotice(`读取生成方案失败：${String(error)}`));
              break;
            }
            case 'error':
              patch((x) => ({
                ...x,
                content: x.content ? `${x.content}\n[错误] ${e.message}` : `[错误] ${e.message}`,
                status: 'failed',
              }));
              break;
            case 'done':
              patch((x) => ({
                ...x,
                status: e.status === 'failed' ? 'failed' : 'done',
                progress: undefined,
              }));
              bumpChatScroll();
              break;
            default:
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      patch((x) => ({
        ...x,
        content: controller.signal.aborted ? (x.content || '任务已停止') : err instanceof Error ? err.message : String(err),
        status: 'failed',
      }));
    } finally {
      chatAbort.current = undefined;
      setBusy(false);
    }
  };

  const saveSimulationConfigs = useCallback(async () => {
    if (!sessionId || !currentRevisionId || !simSetup) throw new Error('请先加载方案');
    await saveSunlightConfig(sessionId, currentRevisionId, simSetup.configs.sunlight);
    await savePedestrianConfig(sessionId, currentRevisionId, simSetup.configs.pedestrian);
  }, [sessionId, currentRevisionId, simSetup]);

  const handleAdoptCandidate = async () => {
    if (!comparison || !sessionId) return;
    setBusy(true);
    try {
      const revisionId = await adoptOptimization(
        sessionId,
        comparison.run.id,
        comparison.candidateId,
        comparison.run.baseRevisionId,
      );
      setComparison(null);
      setAdoptedRevisionId(revisionId);
      await handleSelectDesign(revisionId);
      setNotice(`已采用候选，新版本 ${revisionId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const optimizationBlocked =
    model?.model.sketchStatus === 'rejected'
      ? '草图还原未通过，请重新上传或修正'
      : SKETCH_HUMAN_REVIEW_ENABLED &&
          model?.model.sketchId &&
          model.model.sketchStatus !== 'accepted'
        ? '草图待核对，暂不可优化'
        : !simSetup
          ? '正在加载仿真工况…'
          : undefined;

  const mainContent = comparison ? (
    <OptimizationComparisonView
      data={comparison}
      busy={appBusy}
      onClose={() => setComparison(null)}
      onAdopt={handleAdoptCandidate}
    />
  ) : (
    <Viewer
      content={viewerContent}
      displayMode={viewerDisplay}
      show3d={viewer3d}
      onDisplayModeChange={handleViewerDisplayChange}
      onShow3dChange={setViewer3d}
      focusSpaceId={focusSpaceId}
      onSelectSpace={model?.model.residentialBrief?id=>setFocusSpaceId(id):undefined}
    />
  );

  const sourceModel = briefBaseModel ?? (model?.model.dxfSource ? model : undefined);
  const source = sourceModel?.model.dxfSource;
  const brief = briefDraft?.brief;
  const evaluationLabel = evaluationRunning ? '正在计算采光' : visibleEvaluation?.status === 'completed'
    ? visibleEvaluation.evaluation?.status === 'passed'
      ? visibleEvaluation.evaluation.softUnmetCount ? `${visibleEvaluation.evaluation.softUnmetCount} 个软目标未满足` : '评价已完成'
      : '存在未达标或待确认项'
    : visibleEvaluation?.status === 'failed' ? '采光计算失败'
    : visibleEvaluation?.status === 'stale' ? '评价已过期'
    : visibleEvaluation?.status === 'cancelled' ? '评价已取消'
    : '尚未进行评价';
  const reference = (module: CanvasModule) => { setReferenceModule(module); setChatOpen(true); };
  const missingInputs = generationPrerequisites(sourceModel, brief, briefDraft?.version, briefDraft?.dirty);
  const schemeDesigns = designs.filter(design => design.kind === 'scheme' && design.baseRevisionId === sourceModel?.model.revisionId && (design.briefVersion ?? 0) > 0);
  const schemeModel = model?.spaces.length && schemeDesigns.some(design => design.revisionId === currentRevisionId) ? model : undefined;
  const viewedSchemeRevision = schemeModel ? currentRevisionId : undefined;
  const revisionPicker = <label className="workbench-revision-picker">方案版本
    <select aria-label="方案版本" value={viewedSchemeRevision ?? ''} disabled={appBusy || !schemeDesigns.length}
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onChange={event => void handleSelectDesign(event.target.value)}>
      {!viewedSchemeRevision && <option value="">等待生成候选</option>}
      {schemeDesigns.map(design => <option key={design.revisionId} value={design.revisionId}>{design.revisionId}{design.revisionId === adoptedRevisionId ? ' · 已采用' : ''}</option>)}
    </select>
  </label>;
  const modules: Record<CanvasModule, ModulePresentation> = {
    dxf: { status: source ? '底图已导入' : '等待上传 DXF', action: source ? '查看底图' : '上传底图', content: <>
      <PlanPreview model={sourceModel} fixedOnly />
      <p className="module-meta">{source ? source.filename : 'DXF 固定轮廓与构件'}</p>
      {source && <p className="module-meta">{source.areaM2.toFixed(1)} ㎡ · {source.counts.loadBearingWalls} 段承重墙 · {source.counts.windows} 处窗洞</p>}
    </> },
    graph: { status: briefDraft?.dirty ? '需求尚未保存' : briefDraft?.layoutDirty ? '节点图布局未保存' : brief ? `需求 v${briefDraft?.version}` : '等待空间需求', action: '编辑节点图', content: <>
      <GraphPreview brief={brief} />
      <p className="module-meta">{brief ? `${brief.rooms.length} 个房间 · ${brief.relations.length} 条关系` : '房间、面积范围与空间关系'}</p>
      <p className={`module-meta${briefDraft?.dirty ? ' module-warning' : ''}`}>{briefDraft ? `需求 v${briefDraft.version}${briefDraft.dirty ? ' · 未保存' : briefDraft.version ? ' · 已保存' : ' · 已预填'}${briefDraft.layoutDirty ? ' · 布局未保存' : ''}` : '上传住宅底图后配置空间需求'}</p>
    </> },
    metrics: { status: evaluationLabel, action: '配置 / 评价', content: <div className="module-metrics">
      <p className="module-meta">{viewedSchemeRevision ? `关联方案 ${viewedSchemeRevision}` : '目标已配置 · 评价后显示实测值'}</p>
      {briefDraft && visibleEvaluation && (briefDraft.dirty || briefDraft.version !== visibleEvaluation.briefVersion) && <p className="module-meta module-warning">当前目标已修改 · 实测基于需求 v{visibleEvaluation.briefVersion}</p>}
      {(brief?.rooms.filter(room => roomDaylight(room).enabled).slice(0, 2) ?? []).map(room => {
        const target = roomDaylight(room), actual = visibleEvaluation?.evaluation?.rooms.find(result => result.roomId === room.id);
        return <div className="module-metric-row" key={room.id}><span>{room.name}</span><span>{target.minIlluminanceLux} lx / {Math.round(target.minAreaRatio * 100)}%</span>
          <small>{actual?.actualRatio != null ? `实际 ${(actual.actualRatio * 100).toFixed(1)}%` : '尚无有效实测值'}</small></div>;
      })}
      {brief && <p className="module-meta">共 {brief.rooms.filter(room => roomDaylight(room).enabled).length} 项房间目标 · 完整列表见详情</p>}
      {!brief && <><div className="module-metric-row"><span>日照与疏散</span><span>{simSetup ? '工况已就绪' : '等待配置'}</span></div><p className="module-meta">{simSetup ? `分析日期 ${simSetup.configs.sunlight.analysisDate}` : '上传底图后配置生成目标与工况'}</p></>}
      <span className="module-status">{evaluationLabel}</span>
    </div> },
    scheme: { status: appBusy ? '任务处理中' : viewedSchemeRevision ?? (missingInputs.length ? '等待前置条件' : '可以生成方案'), action: '打开方案', content: <>
      <div className="module-board__interactive" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{revisionPicker}</div>
      <PlanPreview model={schemeModel} />
      {!schemeModel && <p className="module-meta">{missingInputs.length ? `待完成：${missingInputs.join("、")}` : "输入已就绪，通过 Agent 对话生成方案"}</p>}
      <p className="module-meta">{viewedSchemeRevision ? `${viewedSchemeRevision}${viewedSchemeRevision === adoptedRevisionId ? ' · 已采用' : ' · 候选'}` : '描述需求，由 Agent 生成候选'}</p>
      {model?.model.residentialBrief && <p className="module-meta">输入需求 v{model.model.residentialBrief.version} · {evaluationLabel}</p>}
    </> },
  };
  const empty = (title: string, text: string) => <div className="module-focus-empty"><h3>{title}</h3><p>{text}</p></div>;
  const metricsView = briefDraft
    ? <div className="workbench-metric-detail">
        <ResidentialMetricsEditor brief={briefDraft.brief} dirty={briefDraft.dirty} disabled={appBusy} onChange={updateMetricsBrief} onSave={() => void saveBriefDraft()} />
        {model?.model.residentialBrief && <ResidentialEvaluationPanel record={visibleEvaluation} busy={appBusy} running={evaluationRunning}
          onCancel={residentialAbort.current ? () => residentialAbort.current?.abort(new Error('任务已取消')) : undefined}
          onRun={() => void handleEvaluateResidential()} onFocus={id => { setFocusedModule('scheme'); setViewerDisplay('daylight'); setViewer3d(false); setFocusSpaceId(id); }} />}
      </div>
    : sessionId && currentRevisionId && model && simSetup ? <SimulationWorkspace
        revisionId={currentRevisionId} model={model} setup={simSetup} sessionId={sessionId} provider={provider}
        busy={appBusy} blockedReason={optimizationBlocked} notice={notice} viewer={focusedModule === 'metrics' ? <div className="main-viewer">{mainContent}</div> : null}
        onBack={() => setFocusedModule(null)} onBusyChange={setOptimizationBusy} onCompare={setComparison} onFocusSpace={handleFocusSpace}
        beforeStart={saveSimulationConfigs} onConfigs={configs => setSimSetup(value => value ? { ...value, configs } : value)} />
      : <div className="module-focus-empty"><h3>配置仿真指标</h3><p>先打开空间节点图并添加房间，再在此编辑采光目标与评价工况。上传 DXF 后可保存并用于方案生成。</p><button type="button" disabled={appBusy} onClick={() => openModule('graph')}>打开空间节点图 ↗</button></div>;
  const focusViews: Record<CanvasModule, React.ReactNode> = {
    dxf: focusedModule === 'dxf' ? <div className="workbench-plan-detail"><div className="workbench-detail-actions"><Upload kind="dxf" onFile={handleUploadDxf} disabled={appBusy} onError={setNotice} />
      {source && <span>{source.filename} · {source.sourceUnits}</span>}</div>
      {sourceModel ? <Viewer content={{ kind: 'model', model: sourceModel }} displayMode="usage" show3d={viewer3d}
        onDisplayModeChange={() => {}} onShow3dChange={setViewer3d} /> : empty('上传 DXF 固定底图', '读取建筑轮廓、承重墙、门窗与单位信息，供后续空间设计使用。')}</div> : null,
    graph: sessionId ? <SpaceNodeEditor key={`${sessionId}:${briefBaseModel?.model.revisionId ?? 'local-draft'}:${briefDraft?.version ?? 0}`} sessionId={sessionId} model={briefBaseModel}
      busy={appBusy} selectedRoomId={focusSpaceId ?? undefined} onSelectRoom={setFocusSpaceId}
      onBriefChange={onBriefChange} />
      : empty('空间节点图', '点击编辑节点图即可先创建住宅空间草稿，稍后上传 DXF 关联底图。'),
    metrics: metricsView,
    scheme: focusedModule === 'scheme' ? <div className="workbench-plan-detail"><div className="workbench-detail-actions">{revisionPicker}
      <button type="button" disabled={appBusy || !schemeModel} onClick={() => { setAdoptedRevisionId(currentRevisionId); setNotice(`已采用方案 ${currentRevisionId}`); }}>{currentRevisionId && currentRevisionId === adoptedRevisionId ? '已采用' : '采用当前方案'}</button>
      <button type="button" disabled={appBusy || !schemeModel} onClick={openSimulation}>仿真评价 ↗</button>
    </div>
      {model?.model.residentialBrief && <div className="residential-candidate-status" role="status">输入需求 v{model.model.residentialBrief.version} · {model.model.residentialBrief.qualityStatus === 'checked' ? '几何与通行质量已检查' : '空间使用质量待检查'} · {evaluationLabel}</div>}
      {briefBaseModel && sessionId && (solverReportRevision || model?.model.residentialBrief) && <ResidentialSolverReport sessionId={sessionId} revisionId={solverReportRevision ?? currentRevisionId!} base={briefBaseModel} />}
      {schemeModel ? mainContent : empty('等待生成候选', missingInputs.length ? `请先${missingInputs.join('、')}。` : '输入已就绪，请通过 Agent 对话生成方案。')}
    </div> : null,
  };
  const chat = <ChatDropZone disabled={appBusy} onError={setNotice} onFile={(kind, name, base64) => kind === 'dxf' ? handleUploadDxf(name, base64) : handleUploadFile(name, base64)}>
    {selectedSketchId && <div className="workbench-attachments">
      <button type="button" disabled={appBusy} onClick={() => void handleRestoreSketch()}>还原草图</button>
    </div>}
    <Chat messages={messages} scrollAnchor={chatScrollTick} onOpenArtifact={artifact => {
      if (artifact.revisionId && artifact.revisionId !== currentRevisionId) void handleSelectDesign(artifact.revisionId).then(() => openModule(artifact.module));
      else openModule(artifact.module);
    }} />
    {referenceModule && <div className="workbench-reference"><span>引用：{MODULE_TITLES[referenceModule]}{focusSpaceId ? ` / ${focusSpaceId}` : ''}</span><button type="button" aria-label="移除模块引用" onClick={() => setReferenceModule(null)}>×</button></div>}
    {appBusy && (residentialAbort.current || chatAbort.current) && <button type="button" className="workbench-cancel" onClick={() => { residentialAbort.current?.abort(new Error('任务已取消')); chatAbort.current?.abort(new Error('任务已取消')); }}>停止当前任务</button>}
    <Composer disabled={appBusy} placeholder="描述设计需求，或把 DXF、图片拖到这里…" onSend={message => void handleSend(message)} />
  </ChatDropZone>;
  const activeModuleList = CANVAS_MODULES.filter(module => activeBoards.has(module));
  return <DesignWorkbench sessionId={sessionId} provider={provider} providerControl={<ProviderSelect value={provider} options={providers} onChange={handleProviderChange} disabled={appBusy} />}
    busy={appBusy} notice={notice} chat={chat} chatOpen={chatOpen} onChatToggle={() => setChatOpen(open => !open)}
    modules={modules} activeModules={activeModuleList} focusedModule={focusedModule} onOpen={openModule} onClose={() => setFocusedModule(null)} onReference={reference} focusViews={focusViews} />;
}
