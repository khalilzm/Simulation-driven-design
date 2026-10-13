import DxfParser from 'dxf-parser';
import type { ILwpolylineEntity, IPolylineEntity } from 'dxf-parser';
import type { Vec2 } from '@sdd/shared';
import { normalizePolygon, outlineBBox, polygonArea } from '../geometry/polygon';

export interface DxfOutline {
  boundary: Vec2[];
  origin: Vec2;
  bbox: { width: number; height: number; area: number };
}

/** 从 DXF 文本解析建筑外轮廓（面积最大的闭合多边形），坐标归一化到原点 */
export function extractDxfOutline(text: string): DxfOutline | null {
  const parser = new DxfParser();
  const dxf = parser.parseSync(text);
  if (!dxf) return null;

  let best: Vec2[] | null = null;
  let bestArea = 0;

  for (const e of dxf.entities) {
    if (e.type !== 'LWPOLYLINE' && e.type !== 'POLYLINE') continue;
    const vertices = (e as ILwpolylineEntity | IPolylineEntity).vertices;
    if (!vertices || vertices.length < 3) continue;
    const pts = vertices.map((v) => [v.x, v.y] as Vec2);
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9;
    const clean = closed ? pts.slice(0, -1) : pts;
    if (clean.length < 3) continue;
    const area = polygonArea(clean);
    if (area > bestArea) {
      bestArea = area;
      best = clean;
    }
  }

  if (!best) return null;

  const { boundary, origin } = normalizePolygon(best);
  const bbox = outlineBBox(boundary);
  if (!bbox) return null;

  return { boundary, origin, bbox };
}
