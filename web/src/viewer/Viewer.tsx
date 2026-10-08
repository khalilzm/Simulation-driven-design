import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelDisplayMode, ModelViewMode, ViewerContent } from '../types';
import { createScene, type ViewerScene } from './Scene';
import { UsageLegend } from './UsageLegend';
import { SunlightLegend } from './SunlightLegend';
import { PedestrianLegend } from './PedestrianLegend';
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
}: {
  content: ViewerContent;
  displayMode: ModelDisplayMode;
  show3d: boolean;
  onDisplayModeChange: (mode: ModelDisplayMode) => void;
  onShow3dChange: (on: boolean) => void;
  embedded?: boolean;
  playbackTime?: number;
  focusSpaceId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
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
  }, [focusSpaceId]);

  const showDisplayBar = content.kind === 'model' && !embedded;
  const sunlight =
    content.kind === 'model' && displayMode === 'sunlight' && content.sunlight?.status === 'completed'
      ? content.sunlight
      : undefined;
  const pedestrian =
    content.kind === 'model' && displayMode === 'pedestrian' && content.pedestrian?.status === 'completed'
      ? content.pedestrian
      : undefined;
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
          <button
            type="button"
            className={displayMode === 'sunlight' ? 'active' : ''}
            onClick={() => onDisplayModeChange('sunlight')}
            disabled={!content.sunlight || content.sunlight.status !== 'completed'}
            title={!content.sunlight ? '请先运行日照分析' : undefined}
          >
            日照时长
          </button>
          <button
            type="button"
            className={displayMode === 'pedestrian' ? 'active' : ''}
            onClick={() => onDisplayModeChange('pedestrian')}
            disabled={!content.pedestrian || content.pedestrian.status !== 'completed'}
            title={!content.pedestrian ? '请先运行人流疏散分析' : undefined}
          >
            人流疏散
          </button>
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
      <div className="viewer-canvas" ref={ref} />
      {!embedded && content.kind === 'model' && displayMode === 'usage' && <UsageLegend model={content.model} />}
      {!embedded && sunlight && <SunlightLegend result={sunlight} />}
      {!embedded && pedestrian && <PedestrianLegend result={pedestrian} />}
      {content.kind === 'model' && displayMode === 'sunlight' && !sunlight && (
        <div className="viewer-sunlight-empty">运行日照后在此查看房间级时长着色</div>
      )}
      {content.kind === 'model' && displayMode === 'pedestrian' && !pedestrian && (
        <div className="viewer-sunlight-empty">运行疏散后在此查看密度热力图与轨迹</div>
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
        {show3d
          ? '3D 视图（左键平移，右键旋转，滚轮缩放）'
          : displayMode === 'sunlight'
            ? 'Honeybee 传感器网格 · Ladybug Ecotect 色标（直射累计小时）'
            : displayMode === 'pedestrian'
              ? 'JuPedSim 疏散 · 密度热力图 + 轨迹线（绿→红）+ 圆点回放'
              : 'concetto-viewer — 2D 正交俯视（左键平移，滚轮缩放）'}
      </div>}
    </div>
  );
}
