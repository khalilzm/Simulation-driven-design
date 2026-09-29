import { useEffect, useMemo, useRef } from 'react';
import type { ModelDisplayMode, ModelViewMode, ViewerContent } from '../types';
import { createScene, type ViewerScene } from './Scene';
import { UsageLegend } from './UsageLegend';
import { SunlightLegend } from './SunlightLegend';

export function Viewer({
  content,
  displayMode,
  show3d,
  onDisplayModeChange,
  onShow3dChange,
}: {
  content: ViewerContent;
  displayMode: ModelDisplayMode;
  show3d: boolean;
  onDisplayModeChange: (mode: ModelDisplayMode) => void;
  onShow3dChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);

  const viewMode: ModelViewMode = show3d ? '3d' : displayMode;

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

  const showDisplayBar = content.kind === 'model';
  const sunlight =
    content.kind === 'model' && displayMode === 'sunlight' && !show3d && content.sunlight?.status === 'completed'
      ? content.sunlight
      : undefined;

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
          <button
            type="button"
            className={displayMode === 'sunlight' ? 'active' : ''}
            onClick={() => onDisplayModeChange('sunlight')}
            disabled={!content.sunlight || content.sunlight.status !== 'completed'}
            title={!content.sunlight ? '请先运行日照分析' : undefined}
          >
            日照时长
          </button>
        </div>
      )}
      {showDisplayBar && (
        <button
          type="button"
          className={`viewer-3d-toggle${show3d ? ' active' : ''}`}
          aria-pressed={show3d}
          disabled={displayMode !== 'usage'}
          title={displayMode !== 'usage' ? '日照着色仅支持平面视图' : undefined}
          onClick={() => onShow3dChange(!show3d)}
        >
          3D
        </button>
      )}
      <div className="viewer-canvas" ref={ref} />
      {content.kind === 'model' && displayMode === 'usage' && <UsageLegend model={content.model} />}
      {sunlight && <SunlightLegend result={sunlight} />}
      {content.kind === 'model' && displayMode === 'sunlight' && !sunlight && (
        <div className="viewer-sunlight-empty">运行日照后在此查看房间级时长着色</div>
      )}
      <div className="viewer-label">
        {show3d
            ? '3D 视图（左键平移，右键旋转，滚轮缩放）'
            : displayMode === 'sunlight'
              ? 'Honeybee 传感器网格 · Ladybug Ecotect 色标（直射累计小时）'
              : 'concetto-viewer — 2D 正交俯视（左键平移，滚轮缩放）'}
      </div>
    </div>
  );
}
