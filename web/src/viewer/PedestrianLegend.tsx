import type { PedestrianResult } from '@sdd/shared';
import { resolveDensityScale } from './pedestrianColor';
import { sunlightLegendGradientCss, sunlightLegendTicks } from './sunlightColor';

export function PedestrianLegend({ result, scale = resolveDensityScale(result) }: {
  result: PedestrianResult; scale?: ReturnType<typeof resolveDensityScale>;
}) {
  const ticks = sunlightLegendTicks(scale, 5);
  return (
    <div className="sunlight-legend" aria-label="人流密度图例">
      <div className="sunlight-legend-title">峰值密度（人/㎡）</div>
      <div
        className="sunlight-legend-bar sunlight-legend-bar--continuous"
        style={{ background: sunlightLegendGradientCss(scale) }}
      />
      <div className="sunlight-legend-ticks">
        {ticks.map((h) => (
          <span key={h}>{h.toFixed(1)}</span>
        ))}
      </div>
      <div className="sunlight-legend-note">JuPedSim egress · 蓝=空 红=拥堵 · 轨迹线绿(起点)→红(终点)</div>
      <div className="sunlight-legend-engine">{result.engineVersion}</div>
    </div>
  );
}
