import fs from 'node:fs';
import path from 'node:path';
import type { Unit, Vec2 } from '@sdd/shared';
import { polygonGeometryError } from '@sdd/shared';
import { closePolygon, outlineBBox } from '../model/geometry';

export const PROGRAM_OUTLINE_REL = path.join('inputs', 'outline.json');

export interface ProgramOutlinePayload {
  boundary: Vec2[];
  origin: Vec2;
  units: Unit;
  assumptions?: string[];
  bbox?: { width: number; height: number; area: number };
}

/** 校验 Agent / 程序写入的 inputs/outline.json，并规范为 layout 用的 outline JSON 字符串。 */
export function parseProgramOutline(raw: unknown): { ok: true; outlineJson: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'outline.json 须为 JSON 对象' };
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.boundary) || o.boundary.length < 3) {
    return { ok: false, error: 'boundary 须为至少 3 个顶点的数组 [[x,y],…]' };
  }
  const boundary = closePolygon(o.boundary as Vec2[], 0);
  const geometryError = polygonGeometryError(boundary);
  if (geometryError) return { ok: false, error: `boundary ${geometryError}` };
  const origin = Array.isArray(o.origin) && o.origin.length === 2 ? (o.origin as Vec2) : ([0, 0] as Vec2);
  const units: Unit = o.units === 'mm' ? 'mm' : 'm';
  const bbox = outlineBBox(boundary);
  if (!bbox) return { ok: false, error: '无法计算轮廓 bbox' };
  const assumptions = Array.isArray(o.assumptions)
    ? o.assumptions.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    ok: true,
    outlineJson: JSON.stringify({
      boundary,
      origin,
      units,
      bbox,
      ...(assumptions?.length ? { assumptions } : {}),
    }),
  };
}

export function loadProgramOutlineFile(filePath: string): { outlineJson: string } | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = parseProgramOutline(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    return parsed.ok ? { outlineJson: parsed.outlineJson } : null;
  } catch {
    return null;
  }
}
