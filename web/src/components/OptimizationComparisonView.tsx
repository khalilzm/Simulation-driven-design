import { useEffect, useMemo, useState } from 'react';
import type { OptimizationComparison } from '@sdd/shared';
import type { ViewerContent } from '../types';
import { Viewer } from '../viewer/Viewer';
import { SunlightLegend } from '../viewer/SunlightLegend';
import { PedestrianLegend } from '../viewer/PedestrianLegend';
import { comparisonPresentation } from '../viewer/optimizationComparison';
import { lineageSummary } from '@sdd/shared';

const noop = () => {};
const seconds = (value: number | null) => value === null ? '未清空' : `${value.toFixed(2)} 秒`;

export function OptimizationComparisonView({ data, busy, onClose, onAdopt }: {
  data: OptimizationComparison; busy: boolean; onClose: () => void; onAdopt: () => Promise<void>;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const presentation = useMemo(() => comparisonPresentation(data), [data]);
  const contents = useMemo(() => [data.baseline, data.candidate].map((view): ViewerContent => ({
    kind: 'model', ...view, comparison: presentation,
  })), [data, presentation]);
  const planContents = useMemo((): ViewerContent[] => [
    { kind: 'model', model: data.baseline.model },
    { kind: 'model', model: data.candidate.model },
  ], [data.baseline.model, data.candidate.model]);
  const chosen = data.run.candidates.find((candidate) => candidate.id === data.candidateId)!;
  const adopted = data.run.adopted?.candidateId === data.candidateId;
  const candidateLabel = adopted ? `已采用方案 ${data.run.adopted!.revisionId}` : `候选 ${data.candidateId.split('-').at(-1)}`;
  const canAdopt = data.run.status === 'completed'
    && !!chosen.modelHash
    && !!chosen.evaluation
    && (chosen.status === 'completed' || chosen.status === 'rejected')
    && !data.run.adopted;
  const tMax = presentation.pedestrianTimeMax;

  useEffect(() => { setTime(0); setPlaying(false); setError(''); }, [data.run.id, data.candidateId]);
  useEffect(() => {
    if (!playing || tMax <= 0) return;
    let frame = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now;
      setTime((value) => Math.min(tMax, value + dt * 2));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, tMax]);
  useEffect(() => { if (time >= tMax) setPlaying(false); }, [time, tMax]);

  const adopt = async () => {
    setError('');
    try { await onAdopt(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return <section className="optimization-comparison" aria-label="原方案与候选方案的分析对比">
    <header className="comparison-header">
      <div><h2>原方案与{adopted ? '已采用方案' : '候选方案'}对比</h2>
        <p>平面方案与日照、疏散在同一工况下并排对比 · 采用由你决定，不要求系统自动判定为更优</p></div>
      <div className="sunlight-form-actions">
        <button type="button" className="sunlight-form-primary" disabled={busy || !canAdopt} onClick={adopt}>
          {adopted ? `已采用 ${data.run.adopted!.revisionId}` : '采用此方案'}
        </button>
        <button type="button" disabled={busy} onClick={onClose}>返回当前方案</button>
      </div>
    </header>
    {error && <p className="comparison-error" role="alert">{error}</p>}
    {chosen.assessment && <p className="comparison-verdict">
      {chosen.assessment.improved
        ? chosen.assessment.improvementSec === null ? '候选在相同时限内完成清空，日照保护项通过。'
          : `清空时间减少 ${chosen.assessment.improvementSec.toFixed(2)} 秒，日照保护项通过。`
        : chosen.assessment.reasons.join('；')}
      {data.run.adopted && !adopted && ' 本轮已采用其他候选。'}
    </p>}
    <div className="comparison-scroll">
      <div className="comparison-columns comparison-column-headings">
        <div><h3>原方案 · {data.run.baseRevisionId}</h3><p>门宽 {data.run.request.expectedWidthM.toFixed(2)} m · 清空 {seconds(data.baseline.pedestrian.metrics.egressTimeSec)}</p></div>
        <div><h3>{candidateLabel}</h3><p>{lineageSummary(chosen.lineage ?? [chosen.patch])} · 清空 {seconds(data.candidate.pedestrian.metrics.egressTimeSec)}</p></div>
      </div>
      <div className="comparison-analysis-heading">
        <h3>平面方案</h3>
        <p className="comparison-geometry-note">
          门洞 {data.run.request.openingId}：{lineageSummary(chosen.lineage ?? [chosen.patch])}
        </p>
      </div>
      <div className="comparison-columns comparison-maps comparison-maps--plan">
        {planContents.map((content, index) => (
          <div
            className="comparison-map comparison-map--plan"
            key={index}
            aria-label={index === 0 ? '原方案平面' : `${candidateLabel}平面`}
          >
            <Viewer
              content={content}
              displayMode="usage"
              show3d={false}
              embedded
              onDisplayModeChange={noop}
              onShow3dChange={noop}
            />
          </div>
        ))}
      </div>
      <div className="comparison-analysis-heading">
        <h3>日照分析</h3>
        <SunlightLegend result={data.baseline.sunlight} scale={presentation.sunlightScale} />
      </div>
      <div className="comparison-columns comparison-maps">
        {[data.baseline, data.candidate].map((view, index) => <div className="comparison-map" key={index} aria-label={`${index === 0 ? '原方案' : candidateLabel}日照分析图`}>
          {view.sunlight.grids?.some((grid) => grid.faces.length > 0)
            ? <Viewer content={contents[index]} displayMode="sunlight" show3d={false} embedded onDisplayModeChange={noop} onShow3dChange={noop} />
            : <p className="comparison-empty">本次结果未保存日照网格图，仍可查看数值指标。</p>}
        </div>)}
      </div>
      <div className="comparison-analysis-heading">
        <h3>人流分析</h3>
        <PedestrianLegend result={data.baseline.pedestrian} scale={presentation.densityScale} />
      </div>
      <div className="comparison-playback">
        <button type="button" disabled={tMax <= 0} onClick={() => {
          if (time >= tMax) setTime(0);
          setPlaying((value) => !value);
        }}>{playing ? '暂停' : '同步播放'}</button>
        <input aria-label="两方案人流回放时间" type="range" min={0} max={tMax} step={0.1} value={time}
          disabled={tMax <= 0} onChange={(event) => { setPlaying(false); setTime(Number(event.target.value)); }} />
        <span>{time.toFixed(1)} / {tMax.toFixed(1)} 秒</span>
      </div>
      <div className="comparison-columns comparison-maps">
        {[data.baseline, data.candidate].map((view, index) => <div className="comparison-map" key={index} aria-label={`${index === 0 ? '原方案' : candidateLabel}人流分析图`}>
          {view.pedestrian.densityGrid?.faces.length || view.pedestrian.trajectories?.length
            ? <Viewer content={contents[index]} displayMode="pedestrian" show3d={false} embedded playbackTime={time} onDisplayModeChange={noop} onShow3dChange={noop} />
            : <p className="comparison-empty">本次结果未保存密度图和轨迹，仍可查看清空时间。</p>}
        </div>)}
      </div>
    </div>
  </section>;
}
