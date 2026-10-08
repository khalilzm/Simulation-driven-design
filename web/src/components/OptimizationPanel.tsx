import { useEffect, useRef, useState } from 'react';
import type { OptimizationComparison, OptimizationRun, ProviderId, SpaceModel } from '@sdd/shared';
import { AUTOMATIC_OPTIMIZATION, lineageSummary } from '@sdd/shared';
import { latestOptimization, loadOptimizationComparison, streamAutomaticOptimization } from '../api';
import { AnalysisEvidence } from './AnalysisEvidence';

interface Props {
  sessionId?: string;
  revisionId?: string;
  provider: ProviderId;
  model?: SpaceModel;
  busy: boolean;
  blockedReason?: string;
  onBusyChange: (busy: boolean) => void;
  onConfigsReady: (configs: OptimizationRun['configs']) => void;
  onCompare: (comparison: OptimizationComparison | null) => void;
  onFocusSpace?: (spaceId: string) => void;
  beforeStart?: () => Promise<void>;
  onOptimizationStart?: () => void;
  showConfigSettings?: boolean;
  onShowConfigSettings?: () => void;
}

const seconds = (n: number | null | undefined) => n == null ? '未清空' : `${n.toFixed(2)} s`;
const signed = (n: number, digits: number) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
const ratio = (r: number | null | undefined) => r == null ? '未配置目标' : `${(r * 100).toFixed(0)}%`;

export function OptimizationPanel({ sessionId, revisionId, provider, model, busy, blockedReason,
  onBusyChange, onConfigsReady, onCompare, onFocusSpace, beforeStart, onOptimizationStart,
  showConfigSettings = true, onShowConfigSettings }: Props) {
  const [run, setRun] = useState<OptimizationRun | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController>();
  const loadToken = useRef(0);
  const unavailable = blockedReason ?? (provider === 'echo' ? '请选择可用的 Agent 后开始优化。' : undefined);

  useEffect(() => {
    const token = ++loadToken.current;
    const abort = new AbortController();
    if (sessionId && revisionId) latestOptimization(sessionId, revisionId, abort.signal)
      .then((value) => {
        if (loadToken.current !== token) return;
        setRun(value);
      })
      .catch((error) => { if (!abort.signal.aborted) setNotice(String(error)); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [sessionId, revisionId]);

  const start = async () => {
    if (!sessionId || !revisionId || busy || unavailable || controller.current) return;
    ++loadToken.current;
    const abort = new AbortController(); controller.current = abort;
    setRunning(true); onBusyChange(true); setRun(null); onCompare(null); setNotice('检查方案与仿真设置…');
    onOptimizationStart?.();
    try {
      if (beforeStart) await beforeStart();
      const onEvent: Parameters<typeof streamAutomaticOptimization>[2] = (event) => {
        if (event.type === 'progress') setNotice(event.message);
        if (event.type === 'run') {
          setRun(event.run);
          onConfigsReady(event.run.configs);
          if (event.run.status === 'completed') setNotice(event.run.outcome === 'improved'
            ? '已找到通过日照保护检查的改善候选' : event.run.outcome === 'incomplete' ? '部分试算失败，暂未找到可推荐候选' : '本轮未发现明确改善，保留原方案');
          else if (event.run.status === 'needs_input') setNotice(event.run.summary ?? '需要补充需求');
          else if (event.run.error) setNotice(event.run.error);
        }
      };
      await streamAutomaticOptimization({ sessionId, revisionId, provider }, abort.signal, onEvent);
    } catch (error) {
      setNotice(abort.signal.aborted ? '已停止优化；已完成试算保留在记录中' : error instanceof Error ? error.message : String(error));
      if (abort.signal.aborted) setRun((value) => value ? { ...value, status: 'cancelled' } : value);
    } finally { setRunning(false); onBusyChange(false); controller.current = undefined; }
  };

  const compare = async (id: string) => {
    if (!run || !sessionId) return;
    onBusyChange(true);
    try { onCompare(await loadOptimizationComparison(sessionId, run.id, id)); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { onBusyChange(false); }
  };

  if (!model || !sessionId || !revisionId) return null;

  const stage = run?.status === 'completed' ? 3 : run?.status === 'evaluating' ? 2
    : run?.status === 'planning' || run?.status === 'needs_input' ? 1 : 0;

  return <section className="optimization-panel" aria-label="仿真驱动优化">
    <div className="optimization-start">
      <strong>{model.model.sketchId ? '草图已还原' : '方案已就绪'} · 下一步</strong>
      <p>缩短疏散时间，保持日照。自动选择一个可增宽门洞，最多增宽 {AUTOMATIC_OPTIMIZATION.maxIncreaseM} 米。</p>
      <button type="button" className="optimization-primary" disabled={busy || !!unavailable} onClick={() => start()}>
        {running ? '分析优化进行中…' : '分析优化'}
      </button>
      {!showConfigSettings && !running && onShowConfigSettings && (
        <button type="button" className="optimization-secondary" disabled={busy} onClick={onShowConfigSettings}>
          调整仿真工况
        </button>
      )}
      {unavailable && <p className="sunlight-hint warn">{unavailable}</p>}
    </div>
    <div className="optimization-content">
      <p className="sunlight-hint">自动完成基线仿真与最多两个候选的对比，采用后生成新版本。已有仿真设置会保留；首次使用上海冬至日照及按面积估算人数。</p>
      {(running || run) && <ol className="optimization-steps" aria-label="优化步骤">
        {['基线仿真', '生成候选', '复算对比', '选择采用'].map((label, index) => <li key={label}
          aria-current={stage === index ? 'step' : undefined}>{label}</li>)}
      </ol>}
      {notice && <p className="optimization-notice" role="status">{notice}</p>}
      {(running || run) && <div className="sunlight-form-actions">
        {running && <button type="button" onClick={() => controller.current?.abort()}>停止优化</button>}
        <button type="button" disabled={busy} onClick={() => onCompare(null)}>返回当前方案</button>
      </div>}
      {run && <>
        {run.automatic && <p className="sunlight-hint">自动选择可增宽门洞中较窄的 {run.request.openingId} 作为试算对象，是否改善以复算结果为准。
          {run.automatic.createdConfigs.length > 0 && ` 本轮已补齐${run.automatic.createdConfigs.map((name) => name === 'sunlight' ? '默认日照设置' : '按面积估算的疏散人数').join('、')}。`}</p>}
        <p className="sunlight-hint">基线 {run.baseRevisionId} · 门洞 {run.request.openingId} · {run.configs.pedestrian.agents.reduce((n, a) => n + a.count, 0)} 人 · 种子 {run.configs.pedestrian.seed}</p>
        <p className="sunlight-hint">{run.configs.sunlight.analysisDate} {run.configs.sunlight.localTimeRange.join('–')} · 网格 {run.configs.sunlight.sensors.gridSpacing} m。单种子试算结果，用于本轮方案比较。</p>
        {run.summary && <p>{run.summary}</p>}
        {run.error && <p className="sunlight-hint warn">{run.error}</p>}
        {run.baseline && <AnalysisEvidence run={run} model={model} onFocusSpace={onFocusSpace} />}
        {run.baseline && <table className="sunlight-table">
          <thead><tr><th>方案</th><th>改动</th><th>清空时间</th><th>日照达标面积</th><th>最不利空间日照均值变化</th></tr></thead>
          <tbody><tr><td>原方案</td><td>门宽 {run.request.expectedWidthM.toFixed(2)} m</td><td>{seconds(run.baseline.pedestrian.egressTimeSec)}</td><td>{ratio(run.baseline.sunlight.targetAreaRatio)}</td><td>—</td></tr>
            {run.candidates.map((c, i) => <tr key={c.id}>
              <td>候选 {i + 1}{c.id === run.recommendedCandidateId ? ' · 推荐' : ''}</td>
              <td>{lineageSummary(c.lineage ?? [c.patch])}</td><td>{c.evaluation ? seconds(c.evaluation.pedestrian.egressTimeSec) : '未评估'}</td>
              <td>{c.evaluation ? ratio(c.evaluation.sunlight.targetAreaRatio) : '未评估'}</td>
              <td>{c.assessment?.worstMeanHoursDelta != null ? `${signed(c.assessment.worstMeanHoursDelta, 3)} h` : '未评估'}</td>
            </tr>)}
          </tbody>
        </table>}
        {run.candidates.map((c, i) => <div className="optimization-candidate" key={c.id}>
          <strong>候选 {i + 1}{c.id === run.recommendedCandidateId ? ' · 推荐' : ''}</strong>
          <p>试算假设：{c.rationale}</p>
          {c.evaluation && run.baseline && (
            <p>日照达标面积：{ratio(run.baseline.sunlight.targetAreaRatio)} → {ratio(c.evaluation.sunlight.targetAreaRatio)}</p>
          )}
          {c.assessment && <p className={c.assessment.improved ? '' : 'sunlight-hint warn'}>{c.assessment.improved ? c.assessment.improvementSec !== null
            ? `清空时间减少 ${c.assessment.improvementSec.toFixed(2)} 秒；日照保护项通过。`
            : '在相同时间上限内完成清空；日照保护项通过。' : `未采用：${c.assessment.reasons.join('；')}`}</p>}
          {c.error && <p className="sunlight-hint warn">{c.error}</p>}
          <div className="sunlight-form-actions">
            <button type="button" disabled={busy || !run.baseline || !c.modelHash || !c.evaluation} onClick={() => compare(c.id)}>
              {run.adopted?.candidateId === c.id ? `查看已采用方案 ${run.adopted.revisionId} 的对比` : `对比候选 ${i + 1} 的分析图并选择`}
            </button>
          </div>
        </div>)}
      </>}
    </div>
  </section>;
}
