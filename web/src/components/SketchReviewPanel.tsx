import { useState } from 'react';
import type { SketchReport, Vec2 } from '@sdd/shared';
import { inputFileUrl } from '../api';
import './SketchReviewPanel.css';

export function SketchReviewPanel({ sessionId, report, busy, notice, onClose, onCorrect, onConfirm, embedded = false }: {
  sessionId: string;
  report: SketchReport;
  busy: boolean;
  notice?: string;
  onClose: () => void;
  onCorrect: (message: string) => void;
  onConfirm: (calibration?: { wallId: string; lengthM: number }) => void;
  embedded?: boolean;
}) {
  const [opacity, setOpacity] = useState(0.85);
  const [selected, setSelected] = useState<string>();
  const [correction, setCorrection] = useState('');
  const [wallId, setWallId] = useState('');
  const [lengthM, setLengthM] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const { source, extraction } = report;
  const functionalLabels = extraction?.labels.filter((l) => l.kind !== 'dimension') ?? [];
  const dimensionLabels = extraction?.labels.filter((l) => l.kind === 'dimension') ?? [];
  const issuePoint = (objectId?: string): Vec2 | undefined => {
    const label = extraction?.labels.find((l) => l.id === objectId);
    const wall = extraction?.walls.find((w) => w.id === objectId);
    const opening = extraction?.openings.find((o) => o.id === objectId);
    const host = extraction?.walls.find((w) => w.id === opening?.wallId);
    return label?.point ?? wall?.points[0] ?? host?.points[0];
  };
  const selectedIssue = report.issues.find((i) => i.id === selected);
  const selectedPoint = selectedIssue?.point ?? issuePoint(selectedIssue?.objectId);
  const canConfirm = report.geometryValid && !!extraction;
  const calibrationValid = wallId && Number.isFinite(Number(lengthM)) && Number(lengthM) > 0;
  return <section className={`sketch-review-panel${embedded ? ' embedded' : ''}`} aria-label="草图识别结果">
    <header>
      <div><strong>原图与还原结果</strong><span>{source.originalName} · {report.status === 'accepted' ? '已核对' : report.status === 'needs_review' ? '待核对' : '需修正'}</span></div>
      {!embedded && <button onClick={onClose} aria-label="关闭识别结果">关闭</button>}
    </header>
    <div className="sketch-review-controls">
      <label>还原叠加 <input aria-label="还原叠加透明度" type="range" min="0" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
      <span>蓝：墙 · 绿：窗 · 橙：门 · 紫：功能标注 · 青：尺寸数字 · 红：问题</span>
    </div>
    <div className="sketch-review-image">
      <svg viewBox={`0 0 ${source.width} ${source.height}`} role="img" aria-label="原始草图与还原结果叠加">
        <image href={inputFileUrl(sessionId, source.imagePath.split('/').at(-1)!)} width={source.width} height={source.height} />
        {report.overlayPath && <image href={`/api/sketches/${sessionId}/${report.revisionId}/overlay`} width={source.width} height={source.height} opacity={opacity} />}
        {extraction?.walls.filter((wall) => wall.points.length === 2).map((wall) => <polyline key={wall.id}
          points={wall.points.map((point) => point.join(',')).join(' ')} fill="none" stroke={wallId === wall.id ? '#dc7c26' : 'transparent'}
          strokeWidth={Math.max(source.width, source.height) / 65} role="button" tabIndex={busy ? -1 : 0} aria-label={`选择墙 ${wall.id} 校准实长`}
          onClick={() => { if (!busy) { setWallId(wall.id); setConfirmed(false); } }}
          onKeyDown={(event) => { if (!busy && ['Enter', ' '].includes(event.key)) { event.preventDefault(); setWallId(wall.id); setConfirmed(false); } }} />)}
        {selectedPoint && <circle cx={selectedPoint[0]} cy={selectedPoint[1]} r={Math.max(source.width, source.height) / 35} fill="#ff444430" stroke="#e11d48" strokeWidth={3} />}
      </svg>
    </div>
    <div className="sketch-review-details">
      {notice && <p role="status">{notice}</p>}
      <p>{extraction?.walls.length ?? 0} 条识别墙线 · {extraction?.openings.length ?? 0} 个门窗/开口 · {functionalLabels.length} 个功能标注 · {dimensionLabels.length} 个尺寸数字 · {report.calibrated ? '已有尺寸依据' : '比例预览，尚无实际尺寸'}</p>
      {report.timings && <p>本次处理 {(report.timings.durationMs / 1000).toFixed(1)} 秒 · 模型调用 {report.timings.stages.filter((s) => s.phase === 'recognize' || s.phase === 'patch').length} 次</p>}
      {report.adjustments.length > 0 && <details><summary>查看 {report.adjustments.length} 处端点调整</summary><ul>{report.adjustments.map((a, i) => <li key={i}>{a.objectId}：移动 {a.distancePx.toFixed(2)} 像素</li>)}</ul></details>}
      <ul className="sketch-review-issues">{report.issues.map((issue) => <li key={issue.id}>
        <button className={selected === issue.id ? 'selected' : ''} onClick={() => setSelected(issue.id)}>
          <span>{issue.severity === 'error' ? '需修正' : issue.severity === 'review' ? '待确认' : '记录'}</span> {issue.objectId && <b>{issue.objectId} </b>}{issue.message}
        </button>
      </li>)}</ul>
      <form onSubmit={(e) => { e.preventDefault(); if (correction.trim()) onCorrect(`${selectedIssue?.objectId ? `请修正对象 ${selectedIssue.objectId}：` : '请根据原图定点修正：'}${correction}`); }}>
        <label>修正说明<input aria-label="草图修正说明" value={correction} onChange={(e) => setCorrection(e.target.value)} placeholder="例如：L2 应为厨房；D3 应向房间内开启" /></label>
        <button disabled={busy || !correction.trim()}>按说明修正</button>
      </form>
      {canConfirm && <div className="sketch-confirm">
        <p>核对原图后，可补充一面直线墙的实长来确定比例。</p>
        <label>校准墙线<select aria-label="校准墙线" value={wallId} onChange={(e) => setWallId(e.target.value)}><option value="">{report.calibrated ? '沿用图中尺寸' : '选择墙线'}</option>{extraction.walls.filter((w) => w.points.length === 2).map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}</select></label>
        {wallId && <label>实长（米）<input aria-label="墙线实长" type="number" min="0.01" step="any" value={lengthM} onChange={(e) => setLengthM(e.target.value)} /></label>}
        <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我已核对墙体、门窗和文字，并接受上方列出的尺寸假设</label>
        <button disabled={busy || !confirmed || (wallId ? !calibrationValid : !report.calibrated)} onClick={() => onConfirm(wallId ? { wallId, lengthM: Number(lengthM) } : undefined)}>核对完成，设置优化任务</button>
      </div>}
      <p className="sketch-review-note">实际尺寸以图中标注或你提供的实长为准。</p>
    </div>
  </section>;
}
