import { useEffect, useState } from 'react';
import type { ProviderId } from '@sdd/shared';
import { fetchStatus, generate, listDesigns, loadDesign, saveDesign, streamChat, uploadDxf, fetchFileText } from './api';
import type { DesignSummary } from './api';
import type { ProviderOption } from './components/ProviderSelect';
import { ProviderSelect } from './components/ProviderSelect';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { Upload } from './components/Upload';
import { Viewer } from './viewer/Viewer';
import { parseDxfText } from './viewer/dxf';
import { sampleModel } from './examples/sampleModel';
import type { ChatMessage, ViewerContent } from './types';

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

  useEffect(() => {
    fetchStatus()
      .then((s) => setProviders(s.providers))
      .catch((e) => console.error('无法获取提供方状态', e));
  }, []);

  const handleProviderChange = (p: ProviderId) => {
    setProvider(p);
    setSessionId(undefined);
    setMessages([]);
    setDesigns([]);
    setCurrentRevisionId(undefined);
    setViewerContent({ kind: 'empty' });
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
      setViewerContent({ kind: 'model', model: sampleModel });
      setDesigns(await listDesigns(sid));
      setNotice(`已保存方案 ${res.revisionId}`);
    } catch (err) {
      setNotice(`保存失败: ${err instanceof Error ? err.message : String(err)}`);
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
      setViewerContent({ kind: 'model', model });
    } catch (err) {
      setNotice(`读取方案失败: ${err instanceof Error ? err.message : String(err)}`);
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
            <button onClick={handleGenerate} disabled={busy}>
              生成方案
            </button>
          </div>
          {notice && <div className="notice">{notice}</div>}
        </div>
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
      <Viewer content={viewerContent} />
    </div>
  );
}
