import { daylightSettings, roomDaylight, type DaylightSettings, type ResidentialBrief } from '@sdd/shared';

export function ResidentialMetricsEditor({ brief, dirty, disabled, onChange, onSave }: {
  brief: ResidentialBrief;
  dirty: boolean;
  disabled: boolean;
  onChange: (brief: ResidentialBrief) => void;
  onSave: () => void;
}) {
  const settings = daylightSettings(brief);
  const patchSettings = (patch: Partial<DaylightSettings>) => onChange({ ...brief, daylight: { ...settings, ...patch } });
  return <section className="residential-metrics-editor" aria-label="仿真指标配置">
    <header><div><h3>仿真指标配置</h3><p>配置室内采光目标与评价工况；空间节点图只维护房间和关系。</p></div>
      <button type="button" disabled={disabled || !dirty} onClick={onSave}>保存指标{dirty ? ' · 未保存' : ''}</button></header>
    <h4>房间采光目标</h4>
    {!brief.rooms.length && <p>先在空间节点图中添加房间，再为房间指定采光目标。</p>}
    {brief.rooms.map(room => {
      const target = roomDaylight(room);
      return <fieldset key={room.id} disabled={disabled}>
        <legend>{room.name}</legend>
        <label><input type="checkbox" checked={target.enabled} onChange={e => onChange({ ...brief, rooms: brief.rooms.map(r => r.id === room.id ? { ...r, daylight: { ...target, enabled: e.target.checked } } : r) })} />参与采光评价</label>
        {target.enabled && <div className="residential-metrics-fields">
          <label>目标照度（lx）<input type="number" min="1" max="100000" step="50" value={target.minIlluminanceLux} onChange={e => onChange({ ...brief, rooms: brief.rooms.map(r => r.id === room.id ? { ...r, daylight: { ...target, minIlluminanceLux: Number(e.target.value) } } : r) })} /></label>
          <label>达标面积（%）<input type="number" min="1" max="100" value={target.minAreaRatio * 100} onChange={e => onChange({ ...brief, rooms: brief.rooms.map(r => r.id === room.id ? { ...r, daylight: { ...target, minAreaRatio: Number(e.target.value) / 100 } } : r) })} /></label>
          <label>优先级<select value={target.priority} onChange={e => onChange({ ...brief, rooms: brief.rooms.map(r => r.id === room.id ? { ...r, daylight: { ...target, priority: e.target.value as 'hard' | 'soft' } } : r) })}><option value="hard">必须满足</option><option value="soft">尽量满足</option></select></label>
        </div>}
      </fieldset>;
    })}
    <h4>室内采光工况</h4>
    <div className="residential-metrics-fields">
      <label>室外参考照度（lx）<input type="number" min="1000" max="100000" step="1000" value={settings.outdoorIlluminanceLux} onChange={e => patchSettings({ outdoorIlluminanceLux: Number(e.target.value) })} /></label>
      <label>测点间距（m）<input type="number" min="0.1" max="2" step="0.05" value={settings.sensors.gridSpacing} onChange={e => patchSettings({ sensors: { ...settings.sensors, gridSpacing: Number(e.target.value) } })} /></label>
      <label>评价平面高度（m）<input type="number" min="0" max="3" step="0.05" value={settings.sensors.referenceHeightAboveFloor} onChange={e => patchSettings({ sensors: { ...settings.sensors, referenceHeightAboveFloor: Number(e.target.value) } })} /></label>
      {(['wallReflectance','ceilingReflectance','floorReflectance','windowTransmittance'] as const).map((key, i) => <label key={key}>{['墙面反射率','顶面反射率','地面反射率','窗可见光透射率'][i]}<input type="number" min="0.05" max={i === 3 ? 1 : 0.95} step="0.05" value={settings.materials[key]} onChange={e => patchSettings({ materials: { ...settings.materials, [key]: Number(e.target.value) } })} /></label>)}
    </div>
    <p className="space-muted">采用标准阴天天空。采光评价是方案生成后的仿真结果；参数值是比较基准，不代表规范认证。</p>
  </section>;
}
