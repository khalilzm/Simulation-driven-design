import { useEffect, useMemo, useRef } from 'react';
import type { ModelViewMode, ViewerContent } from '../types';
import { createScene, type ViewerScene } from './Scene';
import { UsageLegend } from './UsageLegend';
import { SunlightLegend } from './SunlightLegend';

export function Viewer({
  content,
  viewMode,
  onViewModeChange,
}: {
  content: ViewerContent;
  viewMode: ModelViewMode;
  onViewModeChange: (mode: ModelViewMode) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);

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

  const showTabs = content.kind === 'model';
  const sunlight =
    content.kind === 'model' && viewMode === 'sunlight' && content.sunlight?.status === 'completed'
      ? content.sunlight
      : undefined;

  return (
    <div className="viewer">
      {showTabs && (
        <div className="viewer-tabs">
          <button
            type="button"
            className={viewMode === 'usage' ? 'active' : ''}
            onClick={() => onViewModeChange('usage')}
          >
            平面方案
          </button>
          <button
            type="button"
            className={viewMode === 'sunlight' ? 'active' : ''}
            onClick={() => onViewModeChange('sunlight')}
            disabled={!content.sunlight || content.sunlight.status !== 'completed'}
            title={!content.sunlight ? '请先运行日照分析' : undefined}
          >
            日照时长
          </button>
        </div>
      )}
      <div className="viewer-canvas" ref={ref} />
      {content.kind === 'model' && viewMode === 'usage' && <UsageLegend model={content.model} />}
      {sunlight && <SunlightLegend result={sunlight} />}
      {content.kind === 'model' && viewMode === 'sunlight' && !sunlight && (
        <div className="viewer-sunlight-empty">运行日照后在此查看房间级时长着色</div>
      )}
      <div className="viewer-label">
        {viewMode === 'sunlight'
          ? 'Honeybee 传感器网格 · Ladybug Ecotect 色标（直射累计小时）'
          : 'concetto-viewer — 2D 正交俯视（左键平移，滚轮缩放）'}
      </div>
    </div>
  );
}
