import type { SpaceModel } from '@sdd/shared';
import { doorEndpoints, editableDoors } from '../workbench';

export function SpaceScopeView({ model, selectedId, confirmed, disabled, onSelect, focusSpaceId }: {
  model: SpaceModel; selectedId: string; confirmed: boolean; disabled: boolean;
  onSelect: (id: string) => void; focusSpaceId?: string;
}) {
  const points = model.floor.boundary;
  const minX = Math.min(...points.map((p) => p[0])), maxX = Math.max(...points.map((p) => p[0]));
  const minY = Math.min(...points.map((p) => p[1])), maxY = Math.max(...points.map((p) => p[1]));
  const extent = Math.max(maxX - minX, maxY - minY, 1), pad = extent * 0.08;
  const selected = model.openings.find((opening) => opening.id === selectedId);
  const available = new Set(editableDoors(model).map((opening) => opening.id));
  const svgPoints = (ring: [number, number][]) => ring.map(([x, y]) => `${x},${-y}`).join(' ');
  return <section className="scope-view" aria-label="选择局部改造范围">
    <div className="scope-heading"><strong>在平面上选择门洞</strong><span>灰色：保持不变 · 橙色：可选择 · 绿色：已确认改造范围</span></div>
    <svg viewBox={`${minX - pad} ${-maxY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`} role="img" aria-label="空间模型与可改门洞">
      <polygon points={svgPoints(points)} fill="#faf8f1" stroke="#d2d8d6" strokeWidth={extent * 0.002} />
      {model.spaces.map((space) => {
        const ring = space.boundary.slice(0, -1), x = ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
          y = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
        return <g key={space.id}><polygon points={svgPoints(space.boundary)} fill={focusSpaceId === space.id ? '#f7d5ac' : '#eaf0ee'} stroke="#fff" strokeWidth={extent * 0.001} />
          <text x={x} y={-y} textAnchor="middle" fontSize={extent * 0.024} fill="#5a6864">{space.usage}</text></g>;
      })}
      {model.walls.map((wall) => <polyline key={wall.id} points={svgPoints(wall.geometry.points)} fill="none"
        stroke="#7c8783" strokeWidth={wall.thickness} strokeLinecap="butt"><title>{wall.id} · {wall.fixed || wall.role === 'structural' ? '锁定' : '本轮不移动墙体'}</title></polyline>)}
      {model.openings.filter((opening) => model.doors.some((door) => door.openingId === opening.id)).map((opening) => {
        const endpoints = doorEndpoints(model, opening);
        if (!endpoints.length) return null;
        const allowed = available.has(opening.id), active = opening.id === selectedId;
        const activate = () => { if (allowed && !disabled) onSelect(opening.id); };
        return <g key={opening.id} role="button" tabIndex={allowed && !disabled ? 0 : -1} aria-disabled={!allowed || disabled}
          aria-label={`门洞 ${opening.id}，${opening.width.toFixed(2)} 米${allowed ? '' : '，已锁定'}`} aria-pressed={active}
          onClick={activate} onKeyDown={(event) => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(); } }}>
          <polyline points={svgPoints(endpoints as [number, number][])} stroke={active && confirmed ? '#25816b' : allowed ? '#df9948' : '#aab2af'}
            strokeWidth={extent * (active ? 0.023 : 0.015)} strokeLinecap="round" fill="none" />
          <polyline points={svgPoints(endpoints as [number, number][])} stroke="transparent" strokeWidth={extent * 0.05} fill="none" />
          <title>{opening.id} · {opening.width.toFixed(2)} m{active && !confirmed ? ' · 宿主可改性待确认' : ''}</title>
        </g>;
      })}
    </svg>
    <div className="scope-selection">{selected ? <><strong>{selected.id}</strong> · 门宽 {selected.width.toFixed(2)} m · 宿主墙 {selected.hostWallId}
      <span>{confirmed ? '已确认可改；本轮其余对象保持不变。' : '请在任务卡确认门洞及宿主墙可改。识别为未知属性的墙不会自动获得改造权限。'}</span></>
      : '点击橙色门洞，或在任务卡中选择。当前仅支持一个门洞增宽。'}</div>
  </section>;
}
