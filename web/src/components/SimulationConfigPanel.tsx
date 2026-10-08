import type { OptimizationSetup, SpaceModel } from '@sdd/shared';

export function SimulationConfigPanel({ model, setup, busy, onConfigs }: {
  model: SpaceModel;
  setup: OptimizationSetup;
  busy: boolean;
  onConfigs: (configs: OptimizationSetup['configs']) => void;
}) {
  const { sunlight: sun, pedestrian: ped } = setup.configs;
  const sunPatch = (patch: Partial<typeof sun>) => onConfigs({ ...setup.configs, sunlight: { ...sun, ...patch } });

  const targetGroups = (() => {
    const groups = new Map<string, { key: string; label: string }>();
    for (const space of model.spaces) {
      const key = space.allocationId ?? space.id;
      if (!groups.has(key)) groups.set(key, { key, label: space.usage || space.id });
    }
    return [...groups.values()];
  })();
  const targetHours = (key: string) => sun.targets?.find((t) => t.spaceIds.includes(key))?.minHours ?? 0;
  const patchTarget = (key: string, minHours: number) => {
    sunPatch({ targets: [...(sun.targets ?? []).filter((t) => !t.spaceIds.includes(key)),
      ...(minHours > 0 ? [{ spaceIds: [key], minHours }] : [])] });
  };

  return (
    <section className="sim-config-panel task-form" aria-label="仿真工况设置">
      <h2>仿真工况</h2>
      <p className="muted">开始分析优化前设定日照与疏散参数；将写入当前方案并用于本轮试算。</p>
      {setup.assumptions.map((assumption) => (
        <p className="assumption" key={assumption}>{assumption}</p>
      ))}
      <fieldset disabled={busy}>
        <legend>日照</legend>
        <div className="field-pair">
          <label>纬度<input type="number" step="any" value={sun.location.latitude}
            onChange={(e) => sunPatch({ location: { ...sun.location, latitude: Number(e.target.value) } })} /></label>
          <label>经度<input type="number" step="any" value={sun.location.longitude}
            onChange={(e) => sunPatch({ location: { ...sun.location, longitude: Number(e.target.value) } })} /></label>
        </div>
        <label>时区<input value={sun.location.timezone}
          onChange={(e) => sunPatch({ location: { ...sun.location, timezone: e.target.value } })} /></label>
        <label>分析日期<input type="date" value={sun.analysisDate}
          onChange={(e) => sunPatch({ analysisDate: e.target.value })} /></label>
        <div className="field-pair">
          <label>开始<input type="time" value={sun.localTimeRange[0]}
            onChange={(e) => sunPatch({ localTimeRange: [e.target.value, sun.localTimeRange[1]] })} /></label>
          <label>结束<input type="time" value={sun.localTimeRange[1]}
            onChange={(e) => sunPatch({ localTimeRange: [sun.localTimeRange[0], e.target.value] })} /></label>
        </div>
        <label>北向角（°）<input type="number" value={sun.northDegrees}
          onChange={(e) => sunPatch({ northDegrees: Number(e.target.value) })} /></label>
        <div className="field-pair">
          <label>测点间距（m）<input type="number" min={0.1} step={0.1} value={sun.sensors.gridSpacing}
            onChange={(e) => sunPatch({ sensors: { ...sun.sensors, gridSpacing: Number(e.target.value) } })} /></label>
          <label>测点高度（m）<input type="number" min={0} step={0.1} value={sun.sensors.referenceHeightAboveFloor}
            onChange={(e) => sunPatch({ sensors: { ...sun.sensors, referenceHeightAboveFloor: Number(e.target.value) } })} /></label>
        </div>
        <label>时间步长（分钟）<input type="number" min={1} max={120} value={sun.timestepMinutes}
          onChange={(e) => sunPatch({ timestepMinutes: Number(e.target.value) })} /></label>
        <div className="condition-details">
          <p className="muted">日照目标（达标线）：给需达标的房间设直射小时数，0 或留空 = 不作为目标。</p>
          {targetGroups.map((g) => (
            <label key={g.key}>{g.label} · 达标 ≥（h）
              <input type="number" min={0} step={0.5} value={targetHours(g.key) || ''}
                placeholder="不设目标" onChange={(e) => patchTarget(g.key, Number(e.target.value))} />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>人流疏散</legend>
        {model.spaces.map((space) => (
          <label key={space.id}>
            {space.usage} · 人数
            <input type="number" min={0} step={1} value={ped.agents.find((a) => a.spaceId === space.id)?.count ?? 0}
              onChange={(e) => {
                const count = Number(e.target.value);
                onConfigs({
                  ...setup.configs,
                  pedestrian: {
                    ...ped,
                    agents: [
                      ...ped.agents.filter((a) => a.spaceId !== space.id),
                      ...(count === 0 ? [] : [{ spaceId: space.id, count }]),
                    ],
                  },
                });
              }} />
          </label>
        ))}
        <label>模拟时长上限（秒）<input type="number" min={1} value={ped.maxDurationSec}
          onChange={(e) => onConfigs({ ...setup.configs, pedestrian: { ...ped, maxDurationSec: Number(e.target.value) } })} /></label>
        <label>随机种子<input type="number" step={1} value={ped.seed}
          onChange={(e) => onConfigs({ ...setup.configs, pedestrian: { ...ped, seed: Number(e.target.value) } })} /></label>
      </fieldset>
    </section>
  );
}
