import { ResidentialSolverReport } from './components/ResidentialSolverReport';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OptimizationComparison, OptimizationSetup, ProviderId, SketchReport, SpaceTaskMode, SpaceModel, ResidentialBriefDocument } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import {
  adoptOptimization,
  fetchStatus,
  generate,
  listDesigns,
  loadDesign,
  loadOptimizationSetup,
  saveDesign,
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
import { Composer } from './components/Composer';
import { OptimizationComparisonView } from './components/OptimizationComparisonView';
import { SimulationWorkspace } from './components/SimulationWorkspace';
import { FlowStepper } from './components/FlowStepper';
import { Upload } from './components/Upload';
import { sampleModel } from './examples/sampleModel';
import type { ChatMessage, ModelDisplayMode, ViewerContent } from './types';
import { Viewer } from './viewer/Viewer';
import { SpaceNodeEditor } from './components/SpaceNodeEditor';

type AppScreen = 'plan' | 'simulation';

export default function App() {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderId>('cursor');
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [optimizationBusy, setOptimizationBusy] = useState(false);
  const [viewerContent, setViewerContent] = useState<ViewerContent>({ kind: 'empty' });
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [currentRevisionId, setCurrentRevisionId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [taskMode, setTaskMode] = useState<SpaceTaskMode>('sketch');
  const [selectedSketchId, setSelectedSketchId] = useState<string>();
  const [sketchReport, setSketchReport] = useState<SketchReport>();
  const [viewerDisplay, setViewerDisplay] = useState<ModelDisplayMode>('usage');
  const [viewer3d, setViewer3d] = useState(false);
  const [comparison, setComparison] = useState<OptimizationComparison | null>(null);
  const [appScreen, setAppScreen] = useState<AppScreen>('plan');
  const [simSetup, setSimSetup] = useState<OptimizationSetup | null>(null);
  const [focusSpaceId, setFocusSpaceId] = useState<string | null>(null);
  const [planTab, setPlanTab] = useState<'plan' | 'nodes'>('plan');
  const [briefBaseModel, setBriefBaseModel] = useState<SpaceModel>();
  const [chatScrollTick, setChatScrollTick] = useState(0);
  const chatScrollRef = useRef(0);
  const residentialAbort = useRef<AbortController>();

  const model = viewerContent.kind === 'model' ? viewerContent.model : undefined;
  const appBusy = busy || optimizationBusy;
  const stageIndex = appScreen === 'simulation'
    ? (comparison ? 3 : optimizationBusy ? 2 : 2)
    : (planTab === 'nodes' || (model?.model.dxfSource && !model.spaces.length) ? 1 : model ? 2 : selectedSketchId ? 1 : 0);

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

  const [solverReportRevision,setSolverReportRevision]=useState<string>();
  useEffect(()=>{setSolverReportRevision(undefined);},[sessionId,briefBaseModel?.model.revisionId]);

  useEffect(() => {
    fetchStatus()
      .then((s) => setProviders(s.providers))
      .catch((e) => console.error('无法获取提供方状态', e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const raw = localStorage.getItem('sdd.fixedEnvelope');
      if (raw) {
        const saved = JSON.parse(raw) as { sessionId: string; revisionId: string; provider: ProviderId };
        Promise.all([loadDesign(saved.sessionId,saved.revisionId),listDesigns(saved.sessionId)]).then(([base, versions]) => {
          if (cancelled || !base.model.dxfSource || base.spaces.length) return;
          setSessionId(saved.sessionId); setProvider(saved.provider); setCurrentRevisionId(saved.revisionId);
          setBriefBaseModel(base); setViewerContent({kind:'model',model:base}); setDesigns(versions); setTaskMode('edit');
          setNotice('已恢复住宅固定底图，可打开空间节点图继续编辑已保存需求');
        }).catch(() => { /* A removed workspace need not block a fresh upload. */ });
      }
    } catch { /* Browser storage is optional. */ }
    return () => {cancelled=true;};
  }, []);

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

  useEffect(() => {
    if (appScreen === 'simulation' && (!sessionId || !currentRevisionId || !model)) {
      setAppScreen('plan');
    }
  }, [appScreen, sessionId, currentRevisionId, model]);

  const handleProviderChange = (p: ProviderId) => {
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
    setTaskMode('sketch');
    setAppScreen('plan');
    setBriefBaseModel(undefined); setPlanTab('plan');
    try { localStorage.removeItem('sdd.fixedEnvelope'); } catch { /* optional storage */ }
  };

  const openSimulation = () => {
    if (!model || !sessionId || !currentRevisionId) {
      setNotice('请先上传 DXF、还原草图或加载示例方案');
      return;
    }
    setAppScreen('simulation');
  };

  const ensureSessionId = (): string => {
    const sid = sessionId ?? crypto.randomUUID();
    if (!sessionId) setSessionId(sid);
    return sid;
  };

  const bumpChatScroll = () => {
    chatScrollRef.current += 1;
    setChatScrollTick(chatScrollRef.current);
  };

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
      setPlanTab('plan'); setBriefBaseModel(undefined);
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
      setAppScreen('plan');
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

  const handleLoadSample = async () => {
    const sid = ensureSessionId();
    setBusy(true);
    setNotice('保存示例方案…');
    try {
      const res = await saveDesign(sid, sampleModel);
      if (!res.revisionId) throw new Error('保存方案未返回 revisionId');
      setCurrentRevisionId(res.revisionId);
      setTaskMode('edit');
      setSketchReport(undefined);
      setComparison(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model: sampleModel });
      setPlanTab('plan'); setBriefBaseModel(undefined);
      setDesigns(await listDesigns(sid));
      setAppScreen('plan');
      setNotice(`已加载示例方案 ${res.revisionId}；点击「仿真优化」进入工作区`);
    } catch (err) {
      setNotice(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadDxf = async (name: string, base64: string) => {
    setBusy(true);
    setNotice('正在解析 DXF 固定轮廓与构件…');
    try {
      const result = await uploadDxf(ensureSessionId(), name, base64);
      setSessionId(result.sessionId);
      setCurrentRevisionId(result.revisionId);
      setSelectedSketchId(undefined);
      setSketchReport(undefined);
      setComparison(null);
      setSimSetup(null);
      setTaskMode('edit');
      setAppScreen('plan');
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model: result.model });
      setBriefBaseModel(result.model); setPlanTab('nodes');
      try { localStorage.setItem('sdd.fixedEnvelope',JSON.stringify({sessionId:result.sessionId,revisionId:result.revisionId,provider})); } catch { /* optional storage */ }
      setDesigns(await listDesigns(result.sessionId));
      const source = result.model.model.dxfSource!;
      const summary = `已导入 ${name}：轮廓 ${source.areaM2.toFixed(2)} ㎡，承重墙 ${source.counts.loadBearingWalls} 段，入户 ${source.counts.entrances} 处，窗洞 ${source.counts.windows} 处。`;
      setMessages((previous) => [...previous, { id: crypto.randomUUID(), role: 'user', content: `上传住宅底图：${name}` },
        { id: crypto.randomUUID(), role: 'assistant', content: `${summary}\n固定底图已显示，可切换 3D 检查。${source.warnings.length ? `\n${source.warnings.join('\n')}` : ''}` }]);
      bumpChatScroll();
      setNotice(summary);
    } catch (error) {
      setNotice(`DXF 上传失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  };

  const handleGenerateFromNodes = async (document: ResidentialBriefDocument) => {
    if (!sessionId || appBusy) return;
    const sid = sessionId, assistantId = crypto.randomUUID();
    const controller = new AbortController(); residentialAbort.current=controller;
    const deadline = setTimeout(()=>controller.abort(new Error('生成超过总时限，已取消，请检查需求后重试')),13*60*1000);
    setBusy(true); setNotice('已冻结节点图和日照工况，正在交给 Agent 生成候选…');
    setMessages((previous) => [...previous,{id:crypto.randomUUID(),role:'user',content:`根据空间节点图版本 ${document.version} 和日照设置生成住宅候选`},
      {id:assistantId,role:'assistant',content:'',status:'thinking'}]);
    bumpChatScroll();
    let revision: string | undefined, failed = false;
    const patch = (fn: (message: ChatMessage) => ChatMessage) => setMessages((messages) => messages.map((m) => m.id===assistantId?fn(m):m));
    try {
      await generate(sid,provider,(event) => {
        if(event.type==='progress'){setNotice(event.message);patch((m) => ({...m,progress:event.message}));}
        if(event.type==='text')patch((m) => ({...m,content:m.content+event.text}));
        if(event.type==='thinking')patch((m) => ({...m,thinking:(m.thinking??'')+event.text}));
        if(event.type==='design'){setSolverReportRevision(event.revisionId);if(event.valid)revision=event.revisionId;else {failed=true;setNotice(event.errors.join('；'));}}
        if(event.type==='error'){failed=true;setNotice(event.message);patch((m) => ({...m,content:m.content+'\n'+event.message}));}
        if(event.type==='done'&&event.status==='failed')failed=true;
      },document.brief.baseRevisionId,{mode:'edit',residentialBrief:{baseRevisionId:document.brief.baseRevisionId,version:document.version,baseModelHash:document.baseModelHash}},controller.signal);
      if(!failed&&revision){
        const candidate=await loadDesign(sid,revision);
        setCurrentRevisionId(revision);setViewerContent({kind:'model',model:candidate});setPlanTab('plan');resetViewerToPlan();
        setDesigns(await listDesigns(sid));setNotice('已完成几何、通行净宽及门位检查；日照性能待仿真。可返回节点图修改需求后再次生成。');
      }else if(!failed){failed=true;setNotice('Agent 未交付有效候选，已保留节点图需求');}
      patch((m) => ({...m,status:failed?'failed':'done',progress:undefined}));
    }catch(error){setNotice(controller.signal.aborted ? (controller.signal.reason?.message ?? '生成已取消') : error instanceof Error?error.message:String(error));patch((m) => ({...m,status:'failed',progress:undefined}));}
    finally{clearTimeout(deadline);residentialAbort.current=undefined;setBusy(false);bumpChatScroll();}
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
        if (!generationFailed) setAppScreen('plan');
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
    setBusy(true);
    try {
      if (designs.find((d) => d.revisionId === revisionId)?.sketchId) {
        await showSketchReport(sid, revisionId);
        return;
      }
      setSketchReport(undefined);
      setTaskMode('edit');
      const loaded = await loadDesign(sid, revisionId);
      setPlanTab('plan');
      if(loaded.model.dxfSource&&!loaded.spaces.length)setBriefBaseModel(loaded);
      else if(loaded.model.residentialBrief)setBriefBaseModel(await loadDesign(sid,loaded.model.residentialBrief.baseRevisionId));
      else setBriefBaseModel(undefined);
      setCurrentRevisionId(revisionId);
      setComparison(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model: loaded });
    } catch (err) {
      setNotice(`读取方案失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async (message: string) => {
    if (appBusy) return;
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
    const mode = taskMode;
    try {
      await streamChat(
        {
          provider,
          sessionId,
          message,
          parentRevisionId: mode === 'generate' ? null : currentRevisionId ?? null,
          mode,
          sketchId: selectedSketchId,
        },
        (e) => {
          switch (e.type) {
            case 'session':
              sid = e.sessionId;
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
              setCurrentRevisionId(e.revisionId);
              setTaskMode('edit');
              void loadDesign(sidNow, e.revisionId)
                .then((loaded) => {
                  setViewerContent({ kind: 'model', model: loaded });
                  return listDesigns(sidNow);
                })
                .then(setDesigns);
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
      );
    } catch (err) {
      patch((x) => ({
        ...x,
        content: err instanceof Error ? err.message : String(err),
        status: 'failed',
      }));
    } finally {
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
    />
  );

  const topbar = (
    <header className="topbar">
      <h1>仿真驱动空间生成</h1>
      <FlowStepper current={stageIndex} residential={!!briefBaseModel} />
      <ProviderSelect value={provider} options={providers} onChange={handleProviderChange} />
    </header>
  );

  if (appScreen === 'simulation' && sessionId && currentRevisionId && model) {
    if (!simSetup) {
      return (
        <div className="app app--simulation">
          {topbar}
          <div className="simulation-loading">
            <p>正在加载仿真工况…</p>
            <button type="button" onClick={() => setAppScreen('plan')}>返回方案</button>
          </div>
        </div>
      );
    }
    return (
      <div className="app app--simulation">
        {topbar}
        <SimulationWorkspace
          revisionId={currentRevisionId}
          model={model}
          setup={simSetup}
          sessionId={sessionId}
          provider={provider}
          busy={appBusy}
          blockedReason={optimizationBlocked}
          notice={notice}
          viewer={<div className="main-viewer">{mainContent}</div>}
          onBack={() => setAppScreen('plan')}
          onBusyChange={setOptimizationBusy}
          onCompare={setComparison}
          onFocusSpace={handleFocusSpace}
          beforeStart={saveSimulationConfigs}
          onConfigs={(configs) => setSimSetup((value) => (value ? { ...value, configs } : value))}
        />
      </div>
    );
  }

  return (
    <div className="app">
      {topbar}
      <div className="app-body">
        <div className="sidebar">
          <div className="header">
            <div className="toolbar flow-toolbar">
              <Upload kind="dxf" onFile={handleUploadDxf} disabled={appBusy} onError={setNotice} />
              <Upload onFile={handleUploadFile} disabled={appBusy} onError={setNotice} />
              <button type="button" onClick={() => void handleRestoreSketch()} disabled={appBusy || !selectedSketchId}>
                还原草图
              </button>
              <button type="button" onClick={() => void handleLoadSample()} disabled={appBusy}>
                示例方案
              </button>
              <button type="button" className="toolbar-primary" onClick={openSimulation} disabled={appBusy || !model?.spaces.length}
                title={model && !model.spaces.length ? '当前为固定底图，生成房间布局后再进行仿真优化' : undefined}>
                仿真优化
              </button>
            </div>
            {notice && <div className="notice">{notice}</div>}
          </div>
          {designs.length > 0 && (
            <div className="design-list">
              {designs.map((d) => (
                <button
                  key={d.revisionId}
                  type="button"
                  className={`chip ${d.revisionId === currentRevisionId ? 'active' : ''}`}
                  onClick={() => void handleSelectDesign(d.revisionId)}
                  disabled={appBusy}
                >
                  {d.revisionId}
                </button>
              ))}
            </div>
          )}
          <Chat messages={messages} scrollAnchor={chatScrollTick} />
          <Composer
            disabled={appBusy}
            placeholder="向 Agent 补充图纸说明、修正要求或方案修改…"
            onSend={(message) => void handleSend(message)}
          />
        </div>
        <div className="main-viewer plan-main">
          {briefBaseModel && sessionId && <nav className="plan-mode-tabs" aria-label="住宅设计视图">
            <button className={planTab==='plan'?'active':''} onClick={() => setPlanTab('plan')}>平面与固定底图</button>
            <button className={planTab==='nodes'?'active':''} onClick={() => setPlanTab('nodes')}>空间节点图与日照设置</button>
          </nav>}
          {planTab==='plan' && model?.model.residentialBrief && <div className="residential-candidate-status" role="status">节点图生成候选 · 需求版本 {model.model.residentialBrief.version} · {model.model.residentialBrief.qualityStatus==='checked' ? '几何、通行净宽与门位已检查 · 日照性能待仿真' : model.model.residentialBrief.geometryStatus==='checked' ? '基础几何已检查 · 空间使用质量待验证' : '日照性能与关系兑现待验证'}</div>}
          {briefBaseModel && sessionId && (solverReportRevision||model?.model.residentialBrief) && <ResidentialSolverReport sessionId={sessionId} revisionId={solverReportRevision??currentRevisionId!} base={briefBaseModel}/> }
          {briefBaseModel && sessionId && <div style={{display:planTab==='nodes'?'flex':'none',flex:1,minHeight:0}}>
            <SpaceNodeEditor key={`${sessionId}:${briefBaseModel.model.revisionId}`} sessionId={sessionId} model={briefBaseModel} busy={appBusy} onGenerate={handleGenerateFromNodes} onCancel={residentialAbort.current ? () => residentialAbort.current?.abort(new Error('生成已取消')) : undefined} />
          </div>}
          {planTab==='plan' && mainContent}
        </div>
      </div>
    </div>
  );
}
