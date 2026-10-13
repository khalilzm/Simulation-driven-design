import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BaseBoxShapeUtil, HTMLContainer, T, Tldraw, createBindingId, createShapeId,
  getSnapshot, stopEventPropagation, useEditor, useValue,
  type Editor, type TLShape, type TLShapeId, type TLComponents, type TLUiOverrides,
} from 'tldraw';
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite';
import { CANVAS_MODULES, MODULE_TITLES, moduleShapeId, type CanvasModule } from '@sdd/shared';
import { saveCanvasDocument } from '../api';
import 'tldraw/tldraw.css';

declare module 'tldraw' {
  interface TLGlobalShapePropsMap { 'module-board': { w: number; h: number; module: CanvasModule } }
}
type ModuleShape = TLShape<'module-board'>;
export interface ModulePresentation { content: ReactNode; status: string; action?: string }
interface CanvasContextValue {
  modules: Record<CanvasModule, ModulePresentation>;
  activeModules: CanvasModule[];
  onOpen: (module: CanvasModule) => void;
  onReference: (module: CanvasModule) => void;
}
const CanvasContext = createContext<CanvasContextValue | null>(null);
const DEFAULTS: Record<CanvasModule, { x: number; y: number; w: number; h: number }> = {
  dxf: { x: 40, y: 40, w: 350, h: 260 },
  graph: { x: 40, y: 340, w: 350, h: 280 },
  metrics: { x: 40, y: 660, w: 350, h: 290 },
  scheme: { x: 510, y: 250, w: 550, h: 500 },
};
const boardId = (module: CanvasModule) => moduleShapeId(module) as TLShapeId;
const isModule = (shape: TLShape): shape is ModuleShape => shape.type === 'module-board';
function fitCanvas(editor: Editor) {
  const bounds = editor.getCurrentPageBounds(), viewport = editor.getViewportScreenBounds();
  if (bounds) editor.zoomToBounds(bounds, { inset: 84, targetZoom: Math.min(1, (viewport.w - 168) / bounds.w, (viewport.h - 168) / bounds.h), animation: { duration: 180 } });
}

function BoardContent({ shape }: { shape: ModuleShape }) {
  const context = useContext(CanvasContext)!;
  const editor = useEditor();
  const zoom = useValue('module zoom', () => editor.getZoomLevel(), [editor]);
  const presentation = context.modules[shape.props.module];
  const compact = zoom < .42;
  return <HTMLContainer className={`module-board${compact ? ' module-board--compact' : ''}`}
    style={{ width: shape.props.w, height: shape.props.h, '--board-font': `${Math.min(compact ? 42 : 23, 13 / Math.min(1, zoom))}px` } as React.CSSProperties}
    onDoubleClick={event => { event.stopPropagation(); context.onOpen(shape.props.module); }}
    data-module-board={shape.props.module} aria-label={`${MODULE_TITLES[shape.props.module]}白板`}>
    <header className="module-board__header">
      <span className="module-board__title">{MODULE_TITLES[shape.props.module]}</span>
      <span className="module-board__number">白板 0{CANVAS_MODULES.indexOf(shape.props.module) + 1}</span>
    </header>
    <div className="module-board__content">{compact ? <p className="module-board__compact-label">{presentation.status}</p> : presentation.content}</div>
    <footer className="module-board__footer" onPointerDown={stopEventPropagation} onDoubleClick={stopEventPropagation}>
      <button type="button" onClick={() => context.onReference(shape.props.module)}>引用到对话</button>
      <button type="button" className="board-open" onClick={() => context.onOpen(shape.props.module)}>{presentation.action ?? '打开模块'} ↗</button>
    </footer>
  </HTMLContainer>;
}

class ModuleBoardShapeUtil extends BaseBoxShapeUtil<ModuleShape> {
  static override type = 'module-board' as const;
  static override props = { w: T.number, h: T.number, module: T.literalEnum(...CANVAS_MODULES) };
  override getDefaultProps(): ModuleShape['props'] { return { w: 350, h: 280, module: 'dxf' }; }
  override hideRotateHandle() { return true; }
  override canEdit() { return false; }
  override onBeforeUpdate(_previous: ModuleShape, next: ModuleShape) {
    return { ...next, rotation: 0, props: { ...next.props, w: Math.max(300, next.props.w), h: Math.max(240, next.props.h) } };
  }
  override component(shape: ModuleShape) { return <BoardContent shape={shape} />; }
  override getIndicatorPath(shape: ModuleShape) { const path = new Path2D(); path.rect(0, 0, shape.props.w, shape.props.h); return path; }
}

/** Repairs copies/pastes and older snapshots without ever replacing an existing module's layout. */
function ensureModuleBoards(editor: Editor, activeModules: CanvasModule[]) {
  const active = new Set(activeModules);
  editor.run(() => {
    const pageId = editor.getCurrentPageId();
    const extras = editor.getCurrentPageShapes().filter(shape => isModule(shape)
      && (!CANVAS_MODULES.some(module => shape.id === boardId(module) && shape.props.module === module) || !active.has(shape.props.module)));
    if (extras.length) editor.deleteShapes(extras.map(shape => shape.id));
    for (const module of activeModules) {
      const existing = editor.getShape(boardId(module));
      if (!existing) editor.createShape<ModuleShape>({ id: boardId(module), type: 'module-board', x: DEFAULTS[module].x, y: DEFAULTS[module].y, props: { w: DEFAULTS[module].w, h: DEFAULTS[module].h, module } });
      else if (isModule(existing)) editor.updateShape<ModuleShape>({ id: existing.id, type: 'module-board', parentId: pageId, props: { module } });
    }
    for (const module of ['dxf', 'graph', 'metrics'] as const) {
      const id = createShapeId(`dependency-${module}`);
      if (!active.has(module) || !active.has('scheme')) { if (editor.getShape(id)) editor.deleteShape(id); continue; }
      if (!editor.getShape(id)) {
        editor.createShape({ id, type: 'arrow', x: 0, y: 0, props: { start: { x: 390, y: DEFAULTS[module].y + DEFAULTS[module].h / 2 }, end: { x: 510, y: 500 }, color: 'light-blue', size: 's', dash: 'solid', arrowheadEnd: 'arrow' } });
        editor.createBindings([
          { id: createBindingId(`${module}-start`), type: 'arrow', fromId: id, toId: boardId(module), props: { terminal: 'start', normalizedAnchor: { x: 1, y: .5 }, isExact: true, isPrecise: true } },
          { id: createBindingId(`${module}-end`), type: 'arrow', fromId: id, toId: boardId('scheme'), props: { terminal: 'end', normalizedAnchor: { x: 0, y: module === 'dxf' ? .3 : module === 'graph' ? .5 : .7 }, isExact: true, isPrecise: true } },
        ]);
      }
    }
  }, { history: 'ignore' });
}

function CanvasTools() {
  const editor = useEditor();
  const tool = useValue('active tool', () => editor.getCurrentToolId(), [editor]);
  const zoom = useValue('zoom', () => Math.round(editor.getZoomLevel() * 100), [editor]);
  return <div className="canvas-tools" onPointerDown={stopEventPropagation} onKeyDown={stopEventPropagation}>
    <div className="canvas-tools__group">
      {([['select', '选择'], ['hand', '平移'], ['draw', '画笔'], ['text', '文字']] as const).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={tool === id} onClick={() => editor.setCurrentTool(id)}>{label}</button>)}
    </div>
    <div className="canvas-tools__group">
      <button type="button" aria-label="缩小画布" onClick={() => editor.zoomOut()}>−</button><span>{zoom}%</span>
      <button type="button" aria-label="放大画布" onClick={() => editor.zoomIn()}>＋</button>
      <button type="button" onClick={() => fitCanvas(editor)}>适应全部</button>
    </div>
  </div>;
}
const components: TLComponents = { InFrontOfTheCanvas: CanvasTools };
const overrides: TLUiOverrides = { translations: { 'zh-cn': { 'shortcuts-dialog.disabled-notice': '当前操作不可用', 'comments.link-copied': '链接已复制' } } };
const shapeUtils = [ModuleBoardShapeUtil];
const assetUrls = getAssetUrlsByImport();

export function DesignCanvas({ sessionId, modules, activeModules, onOpen, onReference }: CanvasContextValue & { sessionId?: string }) {
  const editorRef = useRef<Editor | null>(null);
  const activeModulesRef = useRef(activeModules);
  activeModulesRef.current = activeModules;
  const [saveStatus, setSaveStatus] = useState('本机自动保存');
  const [retry, setRetry] = useState(0);
  const context = useMemo(() => ({ modules, activeModules, onOpen, onReference }), [modules, activeModules, onOpen, onReference]);
  const mount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    editor.user.updateUserPreferences({ colorScheme: 'light', locale: 'zh-cn' });
    editor.updateInstanceState({ isGridMode: true });
    let disposed = false, repairing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let repairFrame = 0;
    let saving: Promise<void> = Promise.resolve();
    const repair = () => { if (disposed || repairing) return; repairing = true; try { ensureModuleBoards(editor, activeModulesRef.current); } finally { repairing = false; } };
    const hadBoards = activeModulesRef.current.every(module => editor.getShape(boardId(module)));
    repair();
    if (!hadBoards && activeModulesRef.current.length) fitCanvas(editor);
    const guards = [
      editor.sideEffects.registerBeforeDeleteHandler('shape', shape => {
        if (activeModulesRef.current.some(module => shape.id === boardId(module)) || ['dxf', 'graph', 'metrics'].some(module => shape.id === createShapeId(`dependency-${module}`))) return false;
      }),
      editor.sideEffects.registerBeforeChangeHandler('shape', (previous, next) => {
        if (isModule(previous) && activeModulesRef.current.some(module => previous.id === boardId(module))) {
          return { ...next, type: previous.type, parentId: previous.parentId, rotation: 0, props: { ...next.props, module: previous.props.module } } as ModuleShape;
        }
        return next;
      }),
      editor.sideEffects.registerAfterCreateHandler('shape', shape => {
        if (isModule(shape) && !repairing) { cancelAnimationFrame(repairFrame); repairFrame = requestAnimationFrame(() => repair()); }
      }),
    ];
    const persist = () => {
      if (!sessionId || disposed) return;
      const snapshot = getSnapshot(editor.store);
      setSaveStatus('保存中…');
      saving = saving.catch(() => {}).then(() => saveCanvasDocument(sessionId, snapshot)).then(() => { if (!disposed) setSaveStatus('布局已保存'); }).catch(() => { if (!disposed) setSaveStatus('本机已保存 · 重试'); });
    };
    const unlisten = editor.store.listen(() => {
      clearTimeout(timer); timer = setTimeout(persist, 600);
    }, { source: 'user', scope: 'all' });
    return () => { disposed = true; clearTimeout(timer); cancelAnimationFrame(repairFrame); unlisten(); guards.forEach(dispose => dispose()); editorRef.current = null; };
  }, [sessionId, retry]);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const hadBoards = activeModules.some(module => editor.getShape(boardId(module)));
    ensureModuleBoards(editor, activeModules);
    if (!hadBoards && activeModules.length) fitCanvas(editor);
  }, [activeModules.join(',')]);
  const focus = (module: CanvasModule) => {
    const editor = editorRef.current, bounds = editor?.getShapePageBounds(boardId(module));
    if (editor && bounds) { editor.setCurrentTool('select'); editor.select(boardId(module)); editor.zoomToBounds(bounds, { inset: 64, targetZoom: Math.min(1, editor.getViewportScreenBounds().w / (bounds.w + 128), editor.getViewportScreenBounds().h / (bounds.h + 128)), animation: { duration: 180 } }); }
  };
  return <CanvasContext.Provider value={context}>
    <div className="design-canvas">
      <header className="design-canvas__header"><div><strong>无限画布</strong><span>{activeModules.length ? `${activeModules.length} 个已生成白板` : '通过 Agent 对话生成白板'}</span></div>
        <button className="canvas-save-state" type="button" disabled={!saveStatus.includes('重试')} onClick={() => setRetry(value => value + 1)}>{saveStatus}</button>
      </header>
      {activeModules.length > 0 && <nav className="canvas-module-nav" aria-label="定位已生成白板">{activeModules.map(module => <button key={module} type="button" onClick={() => focus(module)}>{MODULE_TITLES[module]}</button>)}</nav>}
      <div className="design-canvas__surface">
        <Tldraw key={retry} shapeUtils={shapeUtils} components={components}
          assetUrls={assetUrls} overrides={overrides} options={{ maxPages: 1 }} hideUi onMount={mount} licenseKey={import.meta.env.VITE_TLDRAW_LICENSE_KEY || undefined} />
      </div>
    </div>
  </CanvasContext.Provider>;
}
