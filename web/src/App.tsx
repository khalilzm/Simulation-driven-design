import { useEffect, useRef, useState } from 'react';
import type { ProviderId, SunlightConfig, SketchReport, SpaceTaskMode } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import {
  checkSunlight,
  fetchStatus,
  generate,
  listDesigns,
  loadDesign,
  loadSunlightConfig,
  runSunlight,
  fetchSunlightDemoPass,
  saveDesign,
  patchDesignFloor,
  saveSunlightConfig,
  streamChat,
  uploadSketch,
  loadSketchReport,
  confirmSketchReport,
} from './api';
import { chatImageFromInputPath } from './chatImages';
import type { SunlightRunResponse } from './api';
import type { DesignSummary } from './api';
import type { ProviderOption } from './components/ProviderSelect';
import { ProviderSelect } from './components/ProviderSelect';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { Upload } from './components/Upload';
import { Viewer } from './viewer/Viewer';
import { sampleModel } from './examples/sampleModel';
import type { ChatMessage, ModelDisplayMode, ViewerContent } from './types';
import { SunlightPanel } from './components/SunlightPanel';
import { SketchReviewPanel } from './components/SketchReviewPanel';

export default function App() {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<ProviderId>('cursor');
  const [sessionId, setSessionId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [viewerContent, setViewerContent] = useState<ViewerContent>({ kind: 'empty' });
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [currentRevisionId, setCurrentRevisionId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [taskMode, setTaskMode] = useState<SpaceTaskMode>('generate');
  const [selectedSketchId, setSelectedSketchId] = useState<string>();
  const [sketchReport, setSketchReport] = useState<SketchReport>();
  const [sketchReviewOpen, setSketchReviewOpen] = useState(false);
  const [viewerDisplay, setViewerDisplay] = useState<ModelDisplayMode>('usage');
  const [viewer3d, setViewer3d] = useState(false);

  const resetViewerToPlan = () => {
    setViewerDisplay('usage');
    setViewer3d(false);
  };

  const handleViewerDisplayChange = (mode: ModelDisplayMode) => {
    setViewerDisplay(mode);
    setViewer3d(false);
  };
  const [sunlightRun, setSunlightRun] = useState<SunlightRunResponse | null>(null);
  const [sunlightConfig, setSunlightConfig] = useState<SunlightConfig | null | undefined>(undefined);
  const [sunlightPanelOpen, setSunlightPanelOpen] = useState(false);
  const [sunlightPythonOk, setSunlightPythonOk] = useState<boolean | undefined>(undefined);
  const [chatScrollTick, setChatScrollTick] = useState(0);
  const chatScrollRef = useRef(0);

  useEffect(() => {
    fetchStatus()
      .then((s) => setProviders(s.providers))
      .catch((e) => console.error('无法获取提供方状态', e));
    checkSunlight()
      .then((s) => setSunlightPythonOk(s.python.ok))
      .catch(() => setSunlightPythonOk(false));
  }, []);

  useEffect(() => {
    const sid = sessionId;
    const rev = currentRevisionId;
    if (!sid || !rev) {
      setSunlightConfig(undefined);
      return;
    }
    loadSunlightConfig(sid, rev)
      .then((cfg) => setSunlightConfig(cfg))
      .catch(() => setSunlightConfig(null));
  }, [sessionId, currentRevisionId]);

  const withSunlight = (content: ViewerContent): ViewerContent => {
    if (content.kind !== 'model') return content;
    return {
      ...content,
      sunlight: sunlightRun?.result,
    };
  };

  const handleProviderChange = (p: ProviderId) => {
    setProvider(p);
    setSessionId(undefined);
    setMessages([]);
    setDesigns([]);
    setCurrentRevisionId(undefined);
    setViewerContent({ kind: 'empty' });
    setSunlightRun(null);
    setSunlightConfig(undefined);
    resetViewerToPlan();
    setSelectedSketchId(undefined);
    setSketchReport(undefined);
    setSketchReviewOpen(false);
    setTaskMode('generate');
  };

  const ensureSessionId = (): string => {
    const sid = sessionId ?? crypto.randomUUID();
    if (!sessionId) setSessionId(sid);
    return sid;
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
      setSketchReviewOpen(false);
      setSunlightRun(null);
      const image = chatImageFromInputPath(res.sessionId, res.file.name);
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: 'user',
          content: '',
          images: [image],
        },
      ]);
      chatScrollRef.current += 1;
      setChatScrollTick(chatScrollRef.current);
      setNotice(`已上传草图 ${name}；可说明图中尺寸或点击「还原草图」`);
    } catch (err) {
      setNotice(`上传失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const showSketchReport = async (sid: string, revisionId: string) => {
    const report = await loadSketchReport(sid, revisionId);
    setSketchReport(report);
    setSketchReviewOpen(false);
    setSelectedSketchId(report.source.id);
    setTaskMode('sketch');
    setCurrentRevisionId(revisionId);
    setSunlightRun(null);
    resetViewerToPlan();
    if (report.geometryValid && report.model) setViewerContent({ kind: 'model', model: report.model });
    else setViewerContent({ kind: 'empty' });
    setDesigns(await listDesigns(sid));
  };

  const handleConfirmSketch = async (calibration?: { wallId: string; lengthM: number }) => {
    if (!sessionId || !sketchReport) return;
    setBusy(true);
    try {
      const report = await confirmSketchReport(sessionId, sketchReport.revisionId, {
        extractionHash: sketchReport.extractionHash, confirm: true, ...calibration,
      });
      await showSketchReport(sessionId, report.revisionId);
      setNotice(`已确认草图还原 ${report.revisionId}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };

  const handleLoadSample = async () => {
    const sid = ensureSessionId();
    setNotice('保存示例方案…');
    try {
      const res = await saveDesign(sid, sampleModel);
      setCurrentRevisionId(res.revisionId);
      setTaskMode('edit');
      setSketchReport(undefined);
      setSketchReviewOpen(false);
      setSunlightRun(null);
      setViewerContent({ kind: 'model', model: sampleModel });
      setDesigns(await listDesigns(sid));
      setNotice(`已保存方案 ${res.revisionId}`);
    } catch (err) {
      setNotice(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleLoadSunlightDemo = async () => {
    const sid = ensureSessionId();
    setBusy(true);
    setNotice('加载日照达标示例…');
    try {
      const { model, sunlight } = await fetchSunlightDemoPass();
      const res = await saveDesign(sid, model);
      if (!res.revisionId) throw new Error('保存方案未返回 revisionId');
      setTaskMode('edit');
      setSketchReport(undefined);
      setSketchReviewOpen(false);
      await saveSunlightConfig(sid, res.revisionId, sunlight);
      setSunlightConfig(sunlight as SunlightConfig);
      setCurrentRevisionId(res.revisionId);
      setSunlightRun(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model });
      setDesigns(await listDesigns(sid));
      setNotice(`已加载日照示例 ${res.revisionId}（夏至客厅≥1h）；点击「运行日照」查看结果`);
    } catch (err) {
      setNotice(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleGenerate = async () => {
    const sid = ensureSessionId();
    setBusy(true);
    setNotice('生成中…');
    let newRev: string | undefined;
    let designErrors: string[] = [];
    let generationError: string | undefined;
    let generationFailed = false;
    let explanation = '';
    let designWarnings: string[] = [];
    let sketchRevision: string | undefined;
    try {
      await generate(sid, provider, (e) => {
        if (e.type === 'sketchReview') sketchRevision = e.revisionId;
        if (e.type === 'progress') setNotice(e.message);
        if (e.type === 'sketchPreview') {
          const image = chatImageFromInputPath(sid, e.path);
          setMessages((previous) => [
            ...previous,
            { id: crypto.randomUUID(), role: 'assistant', content: '', images: [image], status: 'done' },
          ]);
          chatScrollRef.current += 1;
          setChatScrollTick(chatScrollRef.current);
        }
        if (e.type === 'text') explanation += e.text;
        if (e.type === 'error') generationError = e.message;
        if (e.type === 'done') generationFailed = e.status === 'failed';
        if (e.type === 'design') {
          if (e.valid) newRev = e.revisionId;
          designErrors = e.valid ? [] : e.errors;
          designWarnings = e.warnings ?? [];
          if (!e.valid) setNotice(`方案校验失败: ${e.errors.join('；')}`);
        }
      }, taskMode === 'generate' ? null : currentRevisionId ?? null, { mode: taskMode, sketchId: selectedSketchId });
      if (sketchRevision) {
        if (explanation) setMessages((previous) => [...previous, {
          id: crypto.randomUUID(), role: 'assistant', content: explanation, status: generationFailed ? 'failed' : 'done',
        }]);
        await showSketchReport(sid, sketchRevision);
        setNotice(
          generationFailed
            ? SKETCH_HUMAN_REVIEW_ENABLED
              ? '草图存在需修正的问题，请打开「识别结果」查看'
              : '草图存在需修正的问题，请根据提示重新还原或修正'
            : '草图还原完成，可直接查看平面或运行日照分析',
        );
        return;
      }
      if (explanation) setMessages((previous) => [...previous, {
        id: crypto.randomUUID(), role: 'assistant', content: explanation, status: generationFailed ? 'failed' : 'done',
      }]);
      if (generationError) throw new Error(generationError);
      if (newRev) {
        setTaskMode('edit');
        setSketchReport(undefined);
        setSketchReviewOpen(false);
        const model = await loadDesign(sid, newRev);
        setCurrentRevisionId(newRev);
        setSunlightRun(null);
        resetViewerToPlan();
        setViewerContent({ kind: 'model', model });
        setDesigns(await listDesigns(sid));
        setNotice(`已生成方案 ${newRev}${designWarnings.length ? `；${designWarnings.join('；')}` : ''}`);
      } else {
        setNotice(designErrors.length ? `方案校验失败，保留当前方案：${designErrors.join('；')}` : '未生成方案，请检查上方提示及输入轮廓');
      }
    } catch (err) {
      setNotice(`生成失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSelectDesign = async (revisionId: string) => {
    const sid = sessionId;
    if (!sid) return;
    try {
      if (designs.find((d) => d.revisionId === revisionId)?.sketchId) {
        await showSketchReport(sid, revisionId);
        return;
      }
      setSketchReport(undefined);
      setSketchReviewOpen(false);
      setTaskMode('edit');
      const model = await loadDesign(sid, revisionId);
      setCurrentRevisionId(revisionId);
      setSunlightRun(null);
      resetViewerToPlan();
      setViewerContent({ kind: 'model', model });
    } catch (err) {
      setNotice(`读取方案失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runSunlightForCurrentDesign = async (noticePrefix = '日照分析中…') => {
    const sid = sessionId;
    const rev = currentRevisionId;
    if (!sid || !rev || viewerContent.kind !== 'model') {
      setNotice('请先选择一版方案');
      return;
    }
    setBusy(true);
    setNotice(noticePrefix);
    try {
      const out = await runSunlight(sid, rev);
      setSunlightRun(out);
      setSunlightConfig(out.config);
      const created = out.sunlightConfigCreated ? '；已写入默认 sunlight.json（可编辑后重算）' : '';
      const ver =
        out.result.verification.status === 'passed'
          ? '达标通过'
          : out.result.verification.status === 'failed'
            ? '未达标'
            : '待复核';
      setNotice(
        `日照完成 ${out.taskId.slice(0, 8)}…（间距 ${out.config.sensors.gridSpacing} m，${out.result.metrics.sensorCount} 测点，${ver}）${created}`,
      );
    } catch (err) {
      setNotice(`日照失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRunSunlight = () => runSunlightForCurrentDesign();

  const handleSaveSunlightConfig = async (
    next: SunlightConfig,
    floor: { elevation: number; height: number },
    rerun: boolean,
  ) => {
    const sid = sessionId;
    const rev = currentRevisionId;
    if (!sid || !rev) return;
    setBusy(true);
    try {
      await patchDesignFloor(sid, rev, floor);
      if (viewerContent.kind === 'model') {
        setViewerContent({
          ...viewerContent,
          model: {
            ...viewerContent.model,
            floor: { ...viewerContent.model.floor, elevation: floor.elevation, height: floor.height },
          },
        });
      }
      await saveSunlightConfig(sid, rev, next);
      setSunlightConfig(next);
      if (!rerun) {
        setNotice('已保存楼层标高/层高与 sunlight.json');
        return;
      }
      setNotice('重新计算日照…');
      const out = await runSunlight(sid, rev);
      setSunlightRun(out);
      setSunlightConfig(out.config);
      const ver =
        out.result.verification.status === 'passed'
          ? '达标通过'
          : out.result.verification.status === 'failed'
            ? '未达标'
            : '待复核';
      setNotice(
        `日照完成 · ${out.config.analysisDate} ${out.config.localTimeRange.join('–')} · ${out.result.metrics.sensorCount} 测点 · ${ver}`,
      );
    } catch (err) {
      setNotice(`保存日照配置失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async (message: string, mode = taskMode) => {
    if (busy) return;
    const assistantId = crypto.randomUUID();
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: message };
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', status: 'thinking' };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setBusy(true);
    chatScrollRef.current += 1;
    setChatScrollTick(chatScrollRef.current);

    const patch = (id: string, fn: (x: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((x) => (x.id === id ? fn(x) : x)));

    let sid = sessionId;
    try {
      await streamChat({ provider, sessionId, message, parentRevisionId: mode === 'generate' ? null : currentRevisionId ?? null,
        mode, sketchId: selectedSketchId }, (e) => {
        switch (e.type) {
          case 'session':
            sid = e.sessionId;
            setSessionId(e.sessionId);
            break;
          case 'text':
            patch(assistantId, (x) => ({ ...x, content: x.content + e.text }));
            break;
          case 'thinking':
            patch(assistantId, (x) => ({ ...x, thinking: (x.thinking ?? '') + e.text }));
            break;
          case 'progress':
            patch(assistantId, (x) => ({ ...x, progress: e.message }));
            break;
          case 'sketchPreview': {
            if (!sid) break;
            const image = chatImageFromInputPath(sid, e.path);
            patch(assistantId, (x) => ({ ...x, images: [...(x.images ?? []), image] }));
            chatScrollRef.current += 1;
            setChatScrollTick(chatScrollRef.current);
            break;
          }
          case 'sketchReview': {
            if (sid) void showSketchReport(sid, e.revisionId).catch((error) => setNotice(String(error)));
            patch(assistantId, (x) => ({
              ...x,
              content: `${x.content}\n\n草图还原 ${e.revisionId}：${
                e.status === 'accepted' || !SKETCH_HUMAN_REVIEW_ENABLED
                  ? '平面已就绪，可运行日照分析。'
                  : '可在「识别结果」中补充尺寸或修正标记。'
              }`,
            }));
            break;
          }
          case 'design': {
            if (!sid) break;
            if (mode === 'sketch') break;
            const sidNow = sid;
            if (!e.valid) {
              const errText = e.errors.join('；');
              patch(assistantId, (x) => ({ ...x, progress: errText }));
              chatScrollRef.current += 1;
              setChatScrollTick(chatScrollRef.current);
              break;
            }
            setSunlightPanelOpen(false);
            setSunlightRun(null);
            resetViewerToPlan();
            setCurrentRevisionId(e.revisionId);
            setTaskMode('edit');
            patch(assistantId, (x) => {
              const suffix = `\n\n— 已生成户型 ${e.revisionId}，右侧「平面方案」可查看；需日照时请展开下方「日照分析」。`;
              const base = x.content.trimEnd();
              return {
                ...x,
                progress: undefined,
                content: base ? `${base}${suffix}` : `已生成户型 ${e.revisionId}。${suffix}`,
              };
            });
            chatScrollRef.current += 1;
            setChatScrollTick(chatScrollRef.current);
            loadDesign(sidNow, e.revisionId)
              .then((model) => {
                setViewerContent({ kind: 'model', model });
                return listDesigns(sidNow);
              })
              .then(setDesigns)
              .catch((err) => {
                setNotice(`方案已生成但加载失败: ${err instanceof Error ? err.message : String(err)}`);
              });
            break;
          }
          case 'error':
            patch(assistantId, (x) => ({
              ...x,
              content: x.content ? `${x.content}\n[错误] ${e.message}` : `[错误] ${e.message}`,
              status: 'failed',
            }));
            break;
          case 'done':
            patch(assistantId, (x) => ({
              ...x,
              status: e.status === 'failed' ? 'failed' : 'done',
              progress: undefined,
            }));
            chatScrollRef.current += 1;
            setChatScrollTick(chatScrollRef.current);
            break;
        }
      });
    } catch (err) {
      patch(assistantId, (x) => ({
        ...x,
        content: err instanceof Error ? err.message : String(err),
        status: 'failed',
      }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <div className="sidebar">
        <div className="header">
          <h1>空间自主设计</h1>
          <ProviderSelect value={provider} options={providers} onChange={handleProviderChange} />
          <div className="toolbar">
            <Upload onFile={handleUploadFile} disabled={busy} />
            <select aria-label="方案处理方式" value={taskMode} disabled={busy} onChange={(e) => setTaskMode(e.target.value as SpaceTaskMode)}>
              <option value="generate">文字生成</option>
              <option value="sketch" disabled={!selectedSketchId}>草图还原</option>
              <option
                value="edit"
                disabled={
                  !currentRevisionId ||
                  (SKETCH_HUMAN_REVIEW_ENABLED &&
                    sketchReport?.status !== undefined &&
                    sketchReport.status !== 'accepted')
                }
              >
                方案修改
              </option>
            </select>
            <button onClick={handleLoadSample} disabled={busy}>
              加载示例方案
            </button>
            <button onClick={handleLoadSunlightDemo} disabled={busy} title="带窗户型 + 夏至日照场景，运行后校验应为 passed">
              日照达标示例
            </button>
            <button onClick={handleGenerate} disabled={busy}>
              {taskMode === 'sketch' ? '还原草图' : '生成方案'}
            </button>
            {SKETCH_HUMAN_REVIEW_ENABLED && sketchReport && (
              <button onClick={() => setSketchReviewOpen(true)}>识别结果</button>
            )}
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
                onClick={() => handleSelectDesign(d.revisionId)}
                disabled={busy}
              >
                {d.revisionId}
                {SKETCH_HUMAN_REVIEW_ENABLED && d.sketchStatus && d.sketchStatus !== 'accepted' ? ' · 待核对' : ''}
              </button>
            ))}
          </div>
        )}
        <Chat messages={messages} scrollAnchor={chatScrollTick} />
        <Composer disabled={busy} onSend={handleSend} />
        <div className="sunlight-section">
          <button
            type="button"
            className="sunlight-section-toggle"
            aria-expanded={sunlightPanelOpen}
            onClick={() => setSunlightPanelOpen((open) => !open)}
          >
            日照分析（可选）{sunlightPanelOpen ? ' ▾' : ' ▸'}
          </button>
          {sunlightPanelOpen && (
            <SunlightPanel
              model={viewerContent.kind === 'model' ? viewerContent.model : undefined}
              config={sunlightConfig}
              result={sunlightRun?.result}
              pythonOk={sunlightPythonOk}
              busy={busy}
              canRun={Boolean(
                sessionId &&
                  currentRevisionId &&
                  viewerContent.kind === 'model' &&
                  (SKETCH_HUMAN_REVIEW_ENABLED
                    ? !viewerContent.model.model.sketchId || viewerContent.model.model.sketchStatus === 'accepted'
                    : viewerContent.model.model.sketchStatus !== 'rejected'),
              )}
              onRun={handleRunSunlight}
              onShowMap={() => handleViewerDisplayChange('sunlight')}
              onSaveConfig={handleSaveSunlightConfig}
            />
          )}
        </div>
      </div>
      <Viewer
        content={withSunlight(viewerContent)}
        displayMode={viewerDisplay}
        show3d={viewer3d}
        onDisplayModeChange={handleViewerDisplayChange}
        onShow3dChange={setViewer3d}
      />
      {SKETCH_HUMAN_REVIEW_ENABLED && sessionId && sketchReport && sketchReviewOpen && <SketchReviewPanel
        key={sketchReport.revisionId} sessionId={sessionId} report={sketchReport} busy={busy} notice={notice}
        onClose={() => setSketchReviewOpen(false)} onCorrect={(message) => { setSketchReviewOpen(false); void handleSend(message, 'sketch'); }}
        onConfirm={handleConfirmSketch}
      />}
    </div>
  );
}
