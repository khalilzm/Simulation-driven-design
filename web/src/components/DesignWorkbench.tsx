import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { CANVAS_MODULES, MODULE_TITLES, type CanvasModule } from '@sdd/shared';
import { DesignCanvas, type ModulePresentation } from './DesignCanvas';
import './DesignWorkbench.css';

export function DesignWorkbench({ sessionId, provider, providerControl, busy, notice, chat, chatOpen, onChatToggle, modules,
  activeModules, focusedModule, onOpen, onClose, onReference, focusViews }: {
  sessionId?: string; provider: string; providerControl: ReactNode; busy: boolean; notice?: string;
  chat: ReactNode; chatOpen: boolean; onChatToggle: () => void;
  modules: Record<CanvasModule, ModulePresentation>;
  activeModules: CanvasModule[];
  focusedModule: CanvasModule | null; onOpen: (module: CanvasModule) => void; onClose: () => void;
  onReference: (module: CanvasModule) => void; focusViews: Record<CanvasModule, ReactNode>;
}) {
  const [mobileView, setMobileView] = useState<'chat' | 'canvas'>('canvas');
  const [opened, setOpened] = useState<Set<CanvasModule>>(new Set());
  const [chatWidth, setChatWidth] = useState(() => { try { return Math.max(280, Math.min(480, Number(localStorage.getItem('sdd.chatWidth')) || 340)); } catch { return 340; } });
  const drag = useRef<{ x: number; width: number }>();
  useEffect(() => { setOpened(new Set()); }, [sessionId]);
  useEffect(() => { if (focusedModule) { setOpened(previous => new Set([...previous, focusedModule])); setMobileView('canvas'); } }, [focusedModule, sessionId]);
  const reference = (module: CanvasModule) => { onReference(module); setMobileView('chat'); };
  const rememberWidth = (width: number) => { setChatWidth(width); try { localStorage.setItem('sdd.chatWidth', String(width)); } catch { /* storage is optional */ } };
  return <div className="design-workbench" style={{ '--chat-width': `${chatWidth}px` } as React.CSSProperties}>
    <header className="workbench-topbar">
      <div className="workbench-brand"><span className="workbench-logo" aria-hidden>▱</span><div><h1>仿真驱动空间设计</h1><span>SPATIAL DESIGN LAB</span></div></div>
      <span className="workbench-session">{sessionId ? `工作区 ${sessionId.slice(0, 8)}` : '新建工作区'}</span>
      <span className={`workbench-run-state${busy ? ' is-running' : ''}`} role="status">{busy ? 'Agent 工作中' : '准备就绪'}</span>
      {providerControl}
      <button type="button" className="workbench-chat-toggle" aria-expanded={chatOpen} aria-controls="workbench-agent" onClick={onChatToggle}>{chatOpen ? '收起对话' : '展开对话'}</button>
    </header>
    <nav className="workbench-mobile-nav" aria-label="工作台视图">
      <button type="button" aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}>Agent 对话</button>
      <button type="button" aria-pressed={mobileView === 'canvas'} onClick={() => setMobileView('canvas')}>模块画布</button>
    </nav>
    <div className={`workbench-body${chatOpen ? '' : ' workbench-body--chat-closed'}`} data-mobile-view={mobileView}>
      <aside id="workbench-agent" className="workbench-agent" aria-label="Agent 对话" hidden={!chatOpen && mobileView !== 'chat'}>
        <div className="workbench-agent-heading"><strong>Agent 对话</strong><span>{provider}</span></div>
        {chat}
      </aside>
      {chatOpen && <div className="workbench-resizer" role="separator" aria-label="调整对话栏宽度" aria-orientation="vertical" tabIndex={0}
        aria-valuemin={280} aria-valuemax={480} aria-valuenow={chatWidth}
        onPointerDown={event => { drag.current = { x: event.clientX, width: chatWidth }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) rememberWidth(Math.max(280, Math.min(480, drag.current.width + event.clientX - drag.current.x))); }}
        onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); rememberWidth(Math.max(280, Math.min(480, chatWidth + (event.key === 'ArrowRight' ? 20 : -20)))); } }} />}
      <main className="workbench-canvas-area" aria-label="设计工作区">
        {notice && <div className="workbench-notice" role="status">{notice}</div>}
        <DesignCanvas key={`${sessionId ?? 'draft'}:${provider}`} sessionId={sessionId} modules={modules} activeModules={activeModules} onOpen={onOpen} onReference={reference} />
        <section className="module-focus" aria-label={focusedModule ? `${MODULE_TITLES[focusedModule]}详情` : '模块详情'} hidden={!focusedModule}>
          <header className="module-focus__header"><div><span>模块白板</span><h2>{focusedModule ? MODULE_TITLES[focusedModule] : ''}</h2></div>
            <button type="button" onClick={() => focusedModule && reference(focusedModule)}>引用到对话</button>
            <button type="button" className="module-focus__close" onClick={onClose} disabled={busy}>返回画布 ×</button>
          </header>
          {CANVAS_MODULES.map(module => <div key={module} className="module-focus__view" hidden={focusedModule !== module}>
            <Suspense fallback={<div className="module-focus-empty" role="status">正在加载模块…</div>}>
              {(opened.has(module) || focusedModule === module) && focusViews[module]}
            </Suspense>
          </div>)}
        </section>
      </main>
    </div>
  </div>;
}
