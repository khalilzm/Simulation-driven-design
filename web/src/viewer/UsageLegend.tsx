import type { SpaceModel } from '@sdd/shared';
import { parseSpaceColor } from '@sdd/shared';

function hexToCss(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function UsageLegend({ model }: { model: SpaceModel }) {
  const types = (model.spaceTypes ?? []).filter((t) => !t.container);
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
