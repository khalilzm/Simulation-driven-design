import { useEffect, useState } from 'react';
import type { ProviderId, SunlightConfig } from '@sdd/shared';
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
  uploadDxf,
  fetchFileText,
} from './api';
import type { SunlightRunResponse } from './api';
import type { DesignSummary } from './api';
import type { ProviderOption } from './components/ProviderSelect';
import { ProviderSelect } from './components/ProviderSelect';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { Upload } from './components/Upload';
import { Viewer } from './viewer/Viewer';
import { parseDxfText } from './viewer/dxf';
import { sampleModel } from './examples/sampleModel';
import type { ChatMessage, ModelViewMode, ViewerContent } from './types';
import { SunlightPanel } from './components/SunlightPanel';

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
  const [viewerMode, setViewerMode] = useState<ModelViewMode>('usage');
  const [sunlightRun, setSunlightRun] = useState<SunlightRunResponse | null>(null);
  const [sunlightConfig, setSunlightConfig] = useState<SunlightConfig | null | undefined>(undefined);
  const [sunlightPythonOk, setSunlightPythonOk] = useState<boolean | undefined>();

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
    setViewerMode('usage');
  };

  const ensureSessionId = (): string => {
    const sid = sessionId ?? crypto.randomUUID();
    if (!sessionId) setSessionId(sid);
    return sid;
  };

  const handleUploadFile = async (name: string, base64: string) => {
    setNotice('上传中…');
    try {
      const res = await uploadDxf(sessionId, name, base64);
      setSessionId(res.sessionId);
      const text = await fetchFileText(res.sessionId, res.file.name);
      const entities = parseDxfText(text);
      setCurrentRevisionId(undefined);
      setViewerContent({ kind: 'dxf', entities });
      setNotice(`已上传 ${res.file.name}（${entities.length} 个实体）`);
    } catch (err) {
      setNotice(`上传失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleLoadSample = async () => {
    const sid = ensureSessionId();
    setNotice('保存示例方案…');
    try {
      const res = await saveDesign(sid, sampleModel);
      setCurrentRevisionId(res.revisionId);
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
      await saveSunlightConfig(sid, res.revisionId, sunlight);
      setSunlightConfig(sunlight as SunlightConfig);
      setCurrentRevisionId(res.revisionId);
      setSunlightRun(null);
      setViewerMode('usage');
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
    const sid = sessionId;
    if (!sid) {
      setNotice('请先上传 DXF 或加载示例方案');
      return;
    }
    setBusy(true);
    setNotice('生成中…');
    let newRev: string | undefined;
    let designErrors: string[] = [];
    let generationError: string | undefined;
    let generationFailed = false;
    let explanation = '';
    let designWarnings: string[] = [];
    try {
      await generate(sid, provider, (e) => {
        if (e.type === 'progress') setNotice(e.message);
        if (e.type === 'text') explanation += e.text;
        if (e.type === 'error') generationError = e.message;
        if (e.type === 'done') generationFailed = e.status === 'failed';
        if (e.type === 'design') {
          if (e.valid) newRev = e.revisionId;
          designErrors = e.valid ? [] : e.errors;
          designWarnings = e.warnings ?? [];
          if (!e.valid) setNotice(`方案校验失败: ${e.errors.join('；')}`);
        }
      }, currentRevisionId ?? null);
      if (explanation) setMessages((previous) => [...previous, {
        id: crypto.randomUUID(), role: 'assistant', content: explanation, status: generationFailed ? 'failed' : 'done',
      }]);
      if (generationError) throw new Error(generationError);
      if (newRev) {
        const model = await loadDesign(sid, newRev);
        setCurrentRevisionId(newRev);
        setSunlightRun(null);
        setViewerMode('usage');
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
      const model = await loadDesign(sid, revisionId);
      setCurrentRevisionId(revisionId);
      setSunlightRun(null);
      setViewerMode('usage');
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
      setViewerMode('sunlight');
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
      setViewerMode('sunlight');
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

  const handleSend = async (message: string) => {
    if (busy) return;
    const assistantId = crypto.randomUUID();
    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: message };
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', status: 'thinking' };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setBusy(true);

    const patch = (id: string, fn: (x: ChatMessage) => ChatMessage) =>
      setMessages((m) => m.map((x) => (x.id === id ? fn(x) : x)));

    let sid = sessionId;
    try {
      await streamChat({ provider, sessionId, message, parentRevisionId: currentRevisionId ?? null }, (e) => {
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
          case 'design': {
            if (!sid) break;
            const sidNow = sid;
            if (!e.valid) {
              setNotice(`方案校验失败，保留当前方案：${e.errors.join('；')}`);
              break;
            } else {
              setNotice(`已生成方案 ${e.revisionId}${e.warnings?.length ? `；${e.warnings.join('；')}` : ''}`);
            }
            loadDesign(sidNow, e.revisionId)
              .then((model) => {
                setCurrentRevisionId(e.revisionId);
                setSunlightRun(null);
                setViewerMode('usage');
                setViewerContent({ kind: 'model', model });
                return listDesigns(sidNow);
              })
              .then(setDesigns)
              .catch(() => {});
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
            <button onClick={handleLoadSample} disabled={busy}>
              加载示例方案
            </button>
            <button onClick={handleLoadSunlightDemo} disabled={busy} title="带窗户型 + 夏至日照场景，运行后校验应为 passed">
              日照达标示例
            </button>
            <button onClick={handleGenerate} disabled={busy}>
              生成方案
            </button>
          </div>
          {notice && <div className="notice">{notice}</div>}
        </div>
        <SunlightPanel
          model={viewerContent.kind === 'model' ? viewerContent.model : undefined}
          config={sunlightConfig}
          result={sunlightRun?.result}
          pythonOk={sunlightPythonOk}
          busy={busy}
          canRun={Boolean(sessionId && currentRevisionId && viewerContent.kind === 'model')}
          onRun={handleRunSunlight}
          onShowMap={() => setViewerMode('sunlight')}
          onSaveConfig={handleSaveSunlightConfig}
        />
        {designs.length > 0 && (
          <div className="design-list">
            {designs.map((d) => (
              <button
                key={d.revisionId}
                className={`chip ${d.revisionId === currentRevisionId ? 'active' : ''}`}
                onClick={() => handleSelectDesign(d.revisionId)}
              >
                {d.revisionId}
              </button>
            ))}
          </div>
        )}
        <Chat messages={messages} />
        <Composer disabled={busy} onSend={handleSend} />
      </div>
      <Viewer
        content={withSunlight(viewerContent)}
        viewMode={viewerMode}
        onViewModeChange={setViewerMode}
      />
    </div>
  );
}
