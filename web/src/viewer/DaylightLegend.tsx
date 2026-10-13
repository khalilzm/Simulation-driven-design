import type { DaylightResult } from '@sdd/shared';
import { DAYLIGHT_SCALE } from './sunlightMeshRender';
import { sunlightLegendGradientCss } from './sunlightColor';

export function DaylightLegend({ result }: { result: DaylightResult }) {
  return <div className="sunlight-legend" aria-label="室内照度图例">
    <div className="sunlight-legend-title">室内照度（lx）</div>
    <div className="sunlight-legend-bar sunlight-legend-bar--continuous" style={{background:sunlightLegendGradientCss(DAYLIGHT_SCALE)}}/>
    <div className="sunlight-legend-ticks">{[0,250,500,750,1000].map(v=><span key={v}>{v===1000?'≥1000':v}</span>)}</div>
    <div className="sunlight-legend-note">标准阴天天空 · 室外 {result.outdoorIlluminanceLux.toLocaleString()} lx<br/>采光系数＝室内／室外照度 × 100%</div>
    <div className="sunlight-legend-engine">{result.engineVersion}</div>
  </div>;
}
