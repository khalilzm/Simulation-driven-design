import { useEffect, useRef } from 'react';
import type { ViewerContent } from '../types';
import { createScene, type ViewerScene } from './Scene';
import { UsageLegend } from './UsageLegend';

export function Viewer({ content }: { content: ViewerContent }) {
  const ref = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<ViewerScene | null>(null);

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
    sceneRef.current?.setContent(content);
  }, [content]);

  return (
    <div className="viewer">
      <div className="viewer-canvas" ref={ref} />
      {content.kind === 'model' && <UsageLegend model={content.model} />}
      <div className="viewer-label">concetto-viewer — 2D 正交俯视（左键平移，滚轮缩放）</div>
    </div>
  );
}
