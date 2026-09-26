import { useEffect, useState } from 'react';
import type { SpaceModel, SunlightConfig, SunlightResult } from '@sdd/shared';
import { resolveSpaceLabel } from '@sdd/shared';
import {
  configToDraft,
  DEFAULT_SUNLIGHT_DRAFT,
  type SunlightConfigDraft,
  validateSunlightDraft,
} from '../sunlight/configForm';

export const SUNLIGHT_GRID_SPACING_PRESETS: { spacing: number; label: string; hint?: string }[] = [
  { spacing: 0.5, label: '0.5 m', hint: '细' },
  { spacing: 1.0, label: '1 m', hint: '常用' },
  { spacing: 2.0, label: '2 m', hint: '粗' },
];

const TIMESTEP_PRESETS = [60, 30, 15] as const;

const DATE_PRESETS: { label: string; month: number; day: number }[] = [
  { label: '夏至', month: 6, day: 21 },
  { label: '冬至', month: 12, day: 21 },
];

function spaceLabel(model: SpaceModel, spaceId: string): string {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return spaceId;
  return resolveSpaceLabel(space, model.spaceTypes) || space.usage || spaceId;
}

function verificationClass(status: SunlightResult['verification']['status']): string {
  if (status === 'passed') return 'sunlight-verification passed';
  if (status === 'failed') return 'sunlight-verification failed';
  return 'sunlight-verification review';
}

function yearFromDate(iso: string): number {
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) ? y : new Date().getFullYear();
}

function applyDatePreset(draft: SunlightConfigDraft, month: number, day: number): SunlightConfigDraft {
  const y = yearFromDate(draft.analysisDate);
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { ...draft, analysisDate: `${y}-${mm}-${dd}` };
}

export function SunlightPanel({
  model,
  config,
  result,
  pythonOk,
  busy,
  canRun,
  onRun,
  onShowMap,
  onSaveConfig,
}: {
  model?: SpaceModel;
  config?: SunlightConfig | null;
  result?: SunlightResult;
  pythonOk?: boolean;
  busy: boolean;
  canRun: boolean;
  onRun: () => void;
  onShowMap: () => void;
  onSaveConfig: (
    config: SunlightConfig,
    floor: { elevation: number; height: number },
    rerun: boolean,
  ) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<SunlightConfigDraft>(DEFAULT_SUNLIGHT_DRAFT);
  const [formErrors, setFormErrors] = useState<string[]>([]);

  useEffect(() => {
    if (config) {
      setDraft((d) => ({
        ...configToDraft(config),
        floorElevation: model?.floor.elevation ?? d.floorElevation,
        floorHeight: model?.floor.height ?? d.floorHeight,
      }));
      setFormErrors([]);
    }
  }, [config, model?.floor.elevation, model?.floor.height]);

  useEffect(() => {
    if (!model) return;
    setDraft((d) => ({
      ...d,
      floorElevation: model.floor.elevation,
      floorHeight: model.floor.height,
    }));
  }, [model?.model.revisionId]);

  const patch = (partial: Partial<SunlightConfigDraft>) => {
    setDraft((d) => ({ ...d, ...partial }));
    setFormErrors([]);
  };

  const submitConfig = (rerun: boolean) => {
    const parsed = validateSunlightDraft(draft);
    if (!parsed.ok) {
      setFormErrors(parsed.errors);
      return;
    }
    const merged: SunlightConfig = config?.targets
      ? { ...parsed.config, targets: config.targets }
      : parsed.config;
    void onSaveConfig(merged, { elevation: draft.floorElevation, height: draft.floorHeight }, rerun);
  };

  const sensorCount = result?.status === 'completed' ? result.metrics.sensorCount : null;

  return (
    <div className="sunlight-panel">
      <div className="sunlight-panel-header">
        <span className="sunlight-panel-title">日照分析</span>
        <button type="button" onClick={onRun} disabled={busy || !canRun || pythonOk === false}>
          {busy ? '计算中…' : '运行日照'}
        </button>
      </div>
      {pythonOk === false && (
        <p className="sunlight-hint warn">
          本机未检测到 Ladybug Python 环境，请安装 server/python/sunlight/requirements.txt
        </p>
      )}
      {!canRun && (
        <p className="sunlight-hint">请先保存或选择一版方案。首次运行将自动写入默认 sunlight.json。</p>
      )}
      {canRun && (
        <>
          <div className="sunlight-form">
            <div className="sunlight-form-section">
              <div className="sunlight-sampling-title">地点</div>
              <div className="sunlight-form-row">
                <label className="sunlight-field">
                  <span>纬度 °N</span>
                  <input
                    type="number"
                    step="any"
                    value={draft.latitude}
                    disabled={busy}
                    onChange={(e) => patch({ latitude: Number(e.target.value) })}
                  />
                </label>
                <label className="sunlight-field">
                  <span>经度 °E</span>
                  <input
                    type="number"
                    step="any"
                    value={draft.longitude}
                    disabled={busy}
                    onChange={(e) => patch({ longitude: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label className="sunlight-field sunlight-field--full">
                <span>时区 (IANA)</span>
                <input
                  type="text"
                  value={draft.timezone}
                  disabled={busy}
                  placeholder="Asia/Shanghai"
                  onChange={(e) => patch({ timezone: e.target.value })}
                />
              </label>
            </div>

            <div className="sunlight-form-section">
              <div className="sunlight-sampling-title">分析日与时段</div>
              <label className="sunlight-field sunlight-field--full">
                <span>分析日</span>
                <input
                  type="date"
                  value={draft.analysisDate}
                  disabled={busy}
                  onChange={(e) => patch({ analysisDate: e.target.value })}
                />
              </label>
              <div className="sunlight-spacing-presets">
                <span className="sunlight-spacing-label">快捷</span>
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="sunlight-spacing-chip"
                    disabled={busy}
                    onClick={() => patch(applyDatePreset(draft, p.month, p.day))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="sunlight-form-row">
                <label className="sunlight-field">
                  <span>当地开始</span>
                  <input
                    type="time"
                    value={draft.timeStart}
                    disabled={busy}
                    onChange={(e) => patch({ timeStart: e.target.value })}
                  />
                </label>
                <label className="sunlight-field">
                  <span>当地结束</span>
                  <input
                    type="time"
                    value={draft.timeEnd}
                    disabled={busy}
                    onChange={(e) => patch({ timeEnd: e.target.value })}
                  />
                </label>
              </div>
              <label className="sunlight-field sunlight-field--full">
                <span>时间步长（分钟）</span>
                <div className="sunlight-spacing-presets">
                  {TIMESTEP_PRESETS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={`sunlight-spacing-chip${draft.timestepMinutes === m ? ' active' : ''}`}
                      disabled={busy}
                      onClick={() => patch({ timestepMinutes: m })}
                    >
                      {m} min
                    </button>
                  ))}
                </div>
              </label>
            </div>

            <div className="sunlight-form-section">
              <div className="sunlight-sampling-title">模型与采样</div>
              <label className="sunlight-field sunlight-field--full">
                <span>北向角 north（°，+Y 逆时针至真北）</span>
                <input
                  type="number"
                  step="any"
                  value={draft.northDegrees}
                  disabled={busy}
                  onChange={(e) => patch({ northDegrees: Number(e.target.value) })}
                />
              </label>
              <div className="sunlight-form-row">
                <label className="sunlight-field">
                  <span>楼层标高（m）</span>
                  <input
                    type="number"
                    step="0.01"
                    value={draft.floorElevation}
                    disabled={busy}
                    onChange={(e) => patch({ floorElevation: Number(e.target.value) })}
                  />
                </label>
                <label className="sunlight-field">
                  <span>层高（m）</span>
                  <input
                    type="number"
                    step="0.05"
                    min={0.1}
                    value={draft.floorHeight}
                    disabled={busy}
                    onChange={(e) => patch({ floorHeight: Number(e.target.value) })}
                  />
                </label>
              </div>
              <label className="sunlight-field sunlight-field--full">
                <span>测点高度（相对楼板，m）</span>
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  value={draft.referenceHeightAboveFloor}
                  disabled={busy}
                  onChange={(e) => patch({ referenceHeightAboveFloor: Number(e.target.value) })}
                />
              </label>
              <div className="sunlight-spacing-presets">
                <span className="sunlight-spacing-label">网格间距</span>
                {SUNLIGHT_GRID_SPACING_PRESETS.map((p) => (
                  <button
                    key={p.spacing}
                    type="button"
                    className={`sunlight-spacing-chip${draft.gridSpacing === p.spacing ? ' active' : ''}`}
                    disabled={busy}
                    title={p.hint ? `${p.label}（${p.hint}）` : p.label}
                    onClick={() => patch({ gridSpacing: p.spacing })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {sensorCount !== null && (
                <p className="sunlight-sampling-current">
                  上次计算测点 <strong>{sensorCount}</strong> 个
                </p>
              )}
            </div>

            {formErrors.length > 0 && (
              <p className="sunlight-hint warn">{formErrors.join('；')}</p>
            )}
            <div className="sunlight-form-actions">
              <button type="button" disabled={busy || !canRun} onClick={() => submitConfig(false)}>
                保存 sunlight.json
              </button>
              <button
                type="button"
                className="sunlight-form-primary"
                disabled={busy || !canRun || pythonOk === false}
                onClick={() => submitConfig(true)}
              >
                保存并重算
              </button>
            </div>
            <p className="sunlight-hint">
              日照参数写入 sunlight.json；楼层标高与层高写入本版 model.json（墙高默认与层高一致）。
            </p>
          </div>
        </>
      )}
      {result && (
        <>
          <div className={verificationClass(result.verification.status)}>
            达标结论：{result.verification.status === 'passed' ? '通过' : result.verification.status === 'failed' ? '未通过' : '待复核'}
            {result.verification.checks[0] ? ` — ${result.verification.checks[0]}` : ''}
          </div>
          {result.verification.checks.length > 1 && (
            <p className="sunlight-hint">{result.verification.checks.slice(1).join('；')}</p>
          )}
          {result.status === 'completed' && (
            <button type="button" className="sunlight-map-link" onClick={onShowMap}>
              在右侧查看日照图
            </button>
          )}
          {result.status === 'completed' && model && result.spaces.length > 0 && (
            <table className="sunlight-table">
              <thead>
                <tr>
                  <th>空间</th>
                  <th>均时</th>
                  <th>最短</th>
                  <th>最长</th>
                </tr>
              </thead>
              <tbody>
                {result.spaces.map((row) => (
                  <tr key={row.spaceId}>
                    <td>{spaceLabel(model, row.spaceId)}</td>
                    <td>{row.meanHours.toFixed(2)}</td>
                    <td>{row.minHours.toFixed(2)}</td>
                    <td>{row.maxHours.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {result.error && <p className="sunlight-hint warn">{result.error}</p>}
        </>
      )}
    </div>
  );
}
