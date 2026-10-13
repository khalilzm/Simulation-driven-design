import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelDisplayMode, ModelViewMode, ViewerContent } from '../types';
import { createScene, type ViewerScene } from './Scene';
import { UsageLegend } from './UsageLegend';
import { AnalysisLegend } from './AnalysisLegend';
import { analysisLayerForView, registeredAnalysisLayers } from './analysisLayers';
import { pedestrianTMax } from './pedestrianTrajectories';

const PLAYBACK_SPEED = 2; // 模拟秒 → 墙钟秒 的倍率

export function Viewer({
  content,
  displayMode,
  show3d,
  onDisplayModeChange,
  onShow3dChange,
  embedded = false,
  playbackTime,
  focusSpaceId,
  onSelectSpace,
}: {
  content: ViewerContent;
  displayMode: ModelDisplayMode;
  show3d: boolean;
  onDisplayModeChange: (mode: ModelDisplayMode) => void;
  onShow3dChange: (on: boolean) => void;
  embedded?: boolean;
  playbackTime?: number;
  focusSpaceId?: string | null;
  onSelectSpace?:(spaceId:string|null)=>void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pointerDown=useRef<{x:number;y:number}>();
  const sceneRef = useRef<ViewerScene | null>(null);

  const [pedTime, setPedTime] = useState(0);
  const [playing, setPlaying] = useState(false);

  const viewMode: ModelViewMode =
    show3d && displayMode === 'usage' ? '3d' : displayMode;

  const modelContent = useMemo(
    () => (content.kind === 'model' ? { ...content, view: viewMode } : content),
    [content, viewMode],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scene = createScene(el);
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setContent(modelContent);
  }, [modelContent]);

  useEffect(() => {
    sceneRef.current?.focusSpace(focusSpaceId ?? null);
  }, [focusSpaceId, modelContent]);

  const activeLayer = analysisLayerForView(displayMode);
  const showDisplayBar = content.kind === 'model' && !embedded;
  const analysisCompleted = content.kind === 'model' && !!activeLayer?.isCompleted(content);
  const pedestrian = content.kind === 'model' && activeLayer?.id === 'pedestrian' && analysisCompleted
    ? content.pedestrian : undefined;
  const pedTMax = pedestrian ? pedestrianTMax(pedestrian) : 0;

  useEffect(() => {
    setPedTime(0);
    setPlaying(false);
  }, [displayMode, content.kind === 'model' ? content.pedestrian : undefined]);

  useEffect(() => {
    if (!playing || pedTMax <= 0 || playbackTime !== undefined) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setPedTime((t) => {
        const next = t + dt * PLAYBACK_SPEED;
        if (next >= pedTMax) {
          setPlaying(false);
          return pedTMax;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, pedTMax, playbackTime]);

  useEffect(() => {
    sceneRef.current?.setPedestrianTime(playbackTime ?? pedTime);
  }, [pedTime, playbackTime, pedestrian, modelContent]);

  return (
    <div className="viewer">
      {showDisplayBar && (
        <div className="viewer-tabs">
          <button
            type="button"
            className={displayMode === 'usage' ? 'active' : ''}
            onClick={() => onDisplayModeChange('usage')}
          >
            平面方案
          </button>
          {registeredAnalysisLayers().map(layer => <button key={layer.id}
            type="button" className={displayMode === layer.id ? 'active' : ''}
            onClick={() => onDisplayModeChange(layer.id)} disabled={!layer.isCompleted(content)}
            title={!layer.isCompleted(content) ? layer.emptyMessage : undefined}>
            {layer.label}
          </button>)}
        </div>
      )}
      {showDisplayBar && displayMode === 'usage' && (
        <button
          type="button"
          className={`viewer-3d-toggle${show3d ? ' active' : ''}`}
          aria-pressed={show3d}
          onClick={() => onShow3dChange(!show3d)}
        >
          3D
        </button>
      )}
      <div className="viewer-canvas" ref={ref} onPointerDown={e=>{if(e.button===0)pointerDown.current={x:e.clientX,y:e.clientY};}} onPointerUp={e=>{const start=pointerDown.current;pointerDown.current=undefined;if(e.button!==0||viewMode==='3d'||!start||Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)return;const id=sceneRef.current?.pickSpace(e.clientX,e.clientY)??null;onSelectSpace?.(id);}} />
      {!embedded && content.kind === 'model' && displayMode === 'usage' && <UsageLegend model={content.model} />}
      {!embedded && content.kind === 'model' && activeLayer && <AnalysisLegend capability={activeLayer.id} content={content} />}
      {content.kind === 'model' && activeLayer && !analysisCompleted && (
        <div className="viewer-sunlight-empty">{activeLayer.emptyMessage}</div>
      )}
      {!embedded && pedestrian && pedTMax > 0 && playbackTime === undefined && (
        <div className="pedestrian-playback">
          <button type="button" onClick={() => setPlaying((p) => !p)}>
            {playing ? '暂停' : '播放'}
          </button>
          <input
            type="range"
            min={0}
            max={pedTMax}
            step={0.1}
            value={pedTime}
            onChange={(e) => {
              setPlaying(false);
              setPedTime(Number(e.target.value));
            }}
          />
          <span className="pedestrian-time">
            {pedTime.toFixed(1)}s / {pedTMax.toFixed(1)}s
          </span>
        </div>
      )}
      {!embedded && <div className="viewer-label">
        {viewMode === '3d'
          ? '3D 视图（左键平移，右键旋转，滚轮缩放）'
          : activeLayer
            ? activeLayer.description
            : 'concetto-viewer — 2D 正交俯视（左键平移，滚轮缩放）'}
      </div>}
    </div>
  );
}
