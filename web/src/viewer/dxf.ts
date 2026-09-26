import DxfParser from 'dxf-parser';
import type {
  IArcEntity,
  ICircleEntity,
  ILineEntity,
  ILwpolylineEntity,
  IPolylineEntity,
  ISplineEntity,
} from 'dxf-parser';
import type { DxfEntity } from '../types';

export function parseDxfText(text: string): DxfEntity[] {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  const out: DxfEntity[] = [];
  if (!dxf) return out;

  for (const e of dxf.entities) {
    switch (e.type) {
      case 'LINE': {
        const line = e as ILineEntity;
        if (line.vertices.length >= 2) {
          out.push({ kind: 'polyline', points: line.vertices.map((p) => [p.x, p.y]) });
        }
        break;
      }
      case 'LWPOLYLINE': {
        const lw = e as ILwpolylineEntity;
        if (lw.vertices.length >= 2) {
          out.push({ kind: 'polyline', points: lw.vertices.map((p) => [p.x, p.y]), closed: lw.shape });
        }
        break;
      }
      case 'POLYLINE': {
        const pl = e as IPolylineEntity;
        if (pl.vertices.length >= 2) {
          out.push({ kind: 'polyline', points: pl.vertices.map((p) => [p.x, p.y]), closed: pl.shape });
        }
        break;
      }
      case 'CIRCLE': {
        const c = e as ICircleEntity;
        out.push({ kind: 'circle', center: [c.center.x, c.center.y], radius: c.radius });
        break;
      }
      case 'ARC': {
        const a = e as IArcEntity;
        out.push({
          kind: 'arc',
          center: [a.center.x, a.center.y],
          radius: a.radius,
          startAngle: a.startAngle,
          endAngle: a.endAngle,
        });
        break;
      }
      case 'SPLINE': {
        const s = e as ISplineEntity;
        const pts = s.fitPoints ?? s.controlPoints;
        if (pts && pts.length >= 2) {
          out.push({ kind: 'polyline', points: pts.map((p) => [p.x, p.y]), closed: s.closed });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 把归一化实体展开为扁平 xyz 线段数组（每两个点一条线段，z=0）。 */
export function entitiesToLinePositions(entities: DxfEntity[]): number[] {
  const out: number[] = [];
  const pushSeg = (p0: [number, number], p1: [number, number]) => {
    out.push(p0[0], p0[1], 0, p1[0], p1[1], 0);
  };

  for (const e of entities) {
    if (e.kind === 'polyline') {
      for (let i = 0; i + 1 < e.points.length; i++) pushSeg(e.points[i], e.points[i + 1]);
      const first = e.points[0];
      const last = e.points[e.points.length - 1];
      const coincident = first && last && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9;
      if ((e.closed || coincident) && e.points.length >= 3) pushSeg(last, first);
    } else if (e.kind === 'circle') {
      const seg = 64;
      let prev: [number, number] | null = null;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const p: [number, number] = [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)];
        if (prev) pushSeg(prev, p);
        prev = p;
      }
    } else if (e.kind === 'arc') {
      const seg = 48;
      let prev: [number, number] | null = null;
      for (let i = 0; i <= seg; i++) {
        const a = e.startAngle + (i / seg) * (e.endAngle - e.startAngle);
        const p: [number, number] = [e.center[0] + e.radius * Math.cos(a), e.center[1] + e.radius * Math.sin(a)];
        if (prev) pushSeg(prev, p);
        prev = p;
      }
    }
  }
  return out;
}
