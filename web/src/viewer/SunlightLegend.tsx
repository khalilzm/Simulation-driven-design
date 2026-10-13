import type { SunlightResult } from '@sdd/shared';
import {
  resolveSunlightColorScale,
  sunlightLegendGradientCss,
  sunlightLegendTicks,
} from './sunlightColor';

export function SunlightLegend({ result, scale = resolveSunlightColorScale(result) }: {
  result: SunlightResult; scale?: ReturnType<typeof resolveSunlightColorScale>;
}) {
  const ticks = sunlightLegendTicks(scale, 5);
  const differentTargets=new Set(result.targets?.map(t=>t.minHours)).size>1;
  const targetHours = result.targets?.find((t) => t.met !== undefined)?.minHours ?? result.targets?.[0]?.minHours;

  return (
    <div className="sunlight-legend" aria-label="日照时长图例">
      <div className="sunlight-legend-title">直射累计时长（小时）</div>
      <div
        className="sunlight-legend-bar sunlight-legend-bar--continuous"
        style={{ background: sunlightLegendGradientCss(scale) }}
      />
      <div className="sunlight-legend-ticks">
        {ticks.map((h) => (
          <span key={h}>{h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)}</span>
        ))}
      </div>
      <div className="sunlight-legend-note">
        Ecotect · {scale.min}–{scale.max} h（与平面 GMeshBasic 着色一致）
      </div>
      {targetHours !== undefined && (
        <div className="sunlight-legend-note">
          {differentTargets?'各房间目标时长不同，请查看房间评价表':`参考目标：≥ ${targetHours} h，实际达标按房间面积比例评价`}
        </div>
      )}
      <div className="sunlight-legend-engine">{result.engineVersion}</div>
    </div>
  );
}
