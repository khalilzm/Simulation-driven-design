import type { SpaceModel } from '@sdd/shared';
import { parseSpaceColor } from '@sdd/shared';
import { FIXED_ENVELOPE_COLORS } from './fixedEnvelopePresentation';

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function UsageLegend({ model }: { model: SpaceModel }) {
  const types = (model.spaceTypes ?? []).filter((t) => !t.container);
  const source = model.model.dxfSource;
  if (source && !model.spaces.length) {
    const items = [
      { label: `固定轮廓 · ${source.areaM2.toFixed(2)} ㎡`, color: FIXED_ENVELOPE_COLORS.outline },
      { label: `承重墙 · ${source.counts.loadBearingWalls} 段`, color: FIXED_ENVELOPE_COLORS.wall },
      { label: `入户口 · ${source.counts.entrances} 处`, color: FIXED_ENVELOPE_COLORS.entrance },
      { label: `窗洞 · ${source.counts.windows} 处`, color: FIXED_ENVELOPE_COLORS.window },
    ];
    return (
      <div className="usage-legend" aria-label="DXF 固定构件图例">
        <div className="usage-legend-title">住宅固定底图</div>
        <div>{source.widthM.toFixed(2)} × {source.depthM.toFixed(2)} m · 原图单位 {source.sourceUnits}</div>
        <ul className="usage-legend-list">
          {items.map((item) => <li key={item.label}><span className="usage-legend-swatch" style={{ backgroundColor: hexToCss(item.color) }} /><span>{item.label}</span></li>)}
        </ul>
        <div>房间布局尚未生成 · 图纸 +Y 向上</div>
        {source.warnings.length > 0 && <details><summary>导入说明（{source.warnings.length}）</summary><ul>{source.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      </div>
    );
  }
  if (types.length === 0) return null;

  return (
    <div className="usage-legend" aria-label="功能区配色图例">
      <div className="usage-legend-title">功能区配色</div>
      <ul className="usage-legend-list">
        {types.map((type) => {
          const hex = parseSpaceColor(type.color);
          return (
            <li key={type.id}>
              <span
                className="usage-legend-swatch"
                style={{ backgroundColor: hex !== null ? hexToCss(hex) : type.color }}
              />
              <span>{type.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
