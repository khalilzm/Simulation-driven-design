import type { OptimizationSetup, OptimizationTaskDraft, SpaceModel } from '@sdd/shared';
import { editableDoors } from '../workbench';

export function OptimizationTaskPanel({ model, setup, draft, confirmedEdit, confirmedConditions, busy, summary,
  onDraft, onConfigs, onConfirmEdit, onConfirmConditions, onInterpret, onStart, onAnalyze }: {
  model: SpaceModel; setup: OptimizationSetup; draft: OptimizationTaskDraft; confirmedEdit: boolean; confirmedConditions: boolean;
  busy: boolean; summary?: string; onDraft: (patch: Partial<OptimizationTaskDraft>) => void;
  onConfigs: (configs: OptimizationSetup['configs']) => void; onConfirmEdit: (value: boolean) => void;
  onConfirmConditions: (value: boolean) => void; onInterpret: () => void; onStart: () => void; onAnalyze: () => void;
}) {
  const { sunlight: sun, pedestrian: ped } = setup.configs;
  const doors = editableDoors(model), opening = doors.find((door) => door.id === draft.openingId);
  const sunPatch = (patch: Partial<typeof sun>) => onConfigs({ ...setup.configs, sunlight: { ...sun, ...patch } });
  return <div className="task-form">
    <p className="eyebrow">本轮局部改造</p><h2>目标与范围</h2>
    <p className="muted">目标、条件和允许的修改会固定用于本轮比较。</p>
    <label>希望改善什么？<textarea value={draft.message} disabled={busy} rows={3} onChange={(e) => onDraft({ message: e.target.value })} /></label>
    <button type="button" disabled={busy || !draft.message.trim()} onClick={onInterpret}>让助手整理要求</button>
    {summary && <p className="task-summary" role="status">{summary}</p>}
    <div className="goal-rule"><span>优先改善</span><strong>全部人员的模拟清空时间</strong></div>
    <div className="goal-rule"><span>不得退化</span><strong>所有空间的日照指标</strong></div>
    <div className="goal-rule"><span>次要偏好</span><strong>效果接近时优先少改动</strong></div>
    <label>允许增宽的门洞<select value={draft.openingId} disabled={busy} onChange={(e) => onDraft({ openingId: e.target.value })}>
      <option value="">在图上点选或从列表选择</option>{doors.map((door) => <option key={door.id} value={door.id}>{door.id} · {door.width.toFixed(2)} m</option>)}
    </select></label>
    {!doors.length && <p className="form-warning">没有可选门洞。请检查门洞与宿主识别，固定墙和承重墙保持锁定。</p>}
    <label>最多增宽（米）<input type="number" min={0.02} max={0.6} step={0.02} value={draft.increaseM} disabled={busy}
      onChange={(e) => onDraft({ increaseM: Number(e.target.value) })} /></label>
    <label className="check-field"><input type="checkbox" checked={confirmedEdit} disabled={busy || !opening} onChange={(e) => onConfirmEdit(e.target.checked)} />
      我确认选定门洞及宿主墙可在此范围内改造</label>
    <p className="muted">只改一个门洞，最多试算两个候选。外轮廓、墙位、空间用途和人数保持不变。</p>
    <details className="condition-details"><summary>仿真条件 · {ped.agents.reduce((n, agent) => n + agent.count, 0)} 人 · {sun.analysisDate}</summary>
      {setup.assumptions.map((assumption) => <p className="assumption" key={assumption}>{assumption}</p>)}
      <fieldset disabled={busy}><legend>日照条件</legend>
        <div className="field-pair"><label>纬度<input type="number" step="any" value={sun.location.latitude} onChange={(e) => sunPatch({ location: { ...sun.location, latitude: Number(e.target.value) } })} /></label>
          <label>经度<input type="number" step="any" value={sun.location.longitude} onChange={(e) => sunPatch({ location: { ...sun.location, longitude: Number(e.target.value) } })} /></label></div>
        <label>时区<input value={sun.location.timezone} onChange={(e) => sunPatch({ location: { ...sun.location, timezone: e.target.value } })} /></label>
        <label>分析日期<input type="date" value={sun.analysisDate} onChange={(e) => sunPatch({ analysisDate: e.target.value })} /></label>
        <div className="field-pair"><label>开始<input type="time" value={sun.localTimeRange[0]} onChange={(e) => sunPatch({ localTimeRange: [e.target.value, sun.localTimeRange[1]] })} /></label>
          <label>结束<input type="time" value={sun.localTimeRange[1]} onChange={(e) => sunPatch({ localTimeRange: [sun.localTimeRange[0], e.target.value] })} /></label></div>
        <label>北向角（°，从模型上方逆时针）<input type="number" value={sun.northDegrees} onChange={(e) => sunPatch({ northDegrees: Number(e.target.value) })} /></label>
        <div className="field-pair"><label>测点间距（m）<input type="number" min={0.1} step={0.1} value={sun.sensors.gridSpacing} onChange={(e) => sunPatch({ sensors: { ...sun.sensors, gridSpacing: Number(e.target.value) } })} /></label>
          <label>测点高度（m）<input type="number" min={0} step={0.1} value={sun.sensors.referenceHeightAboveFloor} onChange={(e) => sunPatch({ sensors: { ...sun.sensors, referenceHeightAboveFloor: Number(e.target.value) } })} /></label></div>
        <label>时间步长（分钟）<input type="number" min={1} max={120} value={sun.timestepMinutes} onChange={(e) => sunPatch({ timestepMinutes: Number(e.target.value) })} /></label>
      </fieldset>
      <fieldset disabled={busy}><legend>疏散条件</legend>
        {model.spaces.map((space) => <label key={space.id}>{space.usage} · 人数<input type="number" min={0} step={1} value={ped.agents.find((a) => a.spaceId === space.id)?.count ?? 0}
          onChange={(e) => { const count = Number(e.target.value); onConfigs({ ...setup.configs, pedestrian: { ...ped,
            agents: [...ped.agents.filter((a) => a.spaceId !== space.id), ...(count === 0 ? [] : [{ spaceId: space.id, count }])] } }); }} /></label>)}
        <label>模拟时长上限（秒）<input type="number" min={1} value={ped.maxDurationSec} onChange={(e) => onConfigs({ ...setup.configs, pedestrian: { ...ped, maxDurationSec: Number(e.target.value) } })} /></label>
        <label>随机种子<input type="number" step={1} value={ped.seed} onChange={(e) => onConfigs({ ...setup.configs, pedestrian: { ...ped, seed: Number(e.target.value) } })} /></label>
        <p className="muted">当前分析为疏散场景。固定随机种子用于本轮比较。</p>
      </fieldset>
    </details>
    {setup.assumptions.length > 0 && <p className="assumption">含试算预设，请展开仿真条件核对地点、朝向和人数。</p>}
    <label className="check-field"><input type="checkbox" disabled={busy} checked={confirmedConditions} onChange={(e) => onConfirmConditions(e.target.checked)} />已核对本轮仿真条件及使用的假设</label>
    <div className="task-actions"><button className="primary" type="button" disabled={busy || !confirmedConditions || !confirmedEdit || !opening || !draft.message.trim()
      || !Number.isFinite(draft.increaseM) || draft.increaseM < 0.02 || draft.increaseM > 0.6} onClick={onStart}>开始本轮优化</button>
      <button type="button" disabled={busy || !confirmedConditions} onClick={onAnalyze}>先分析现状</button></div>
  </div>;
}
