import fs from 'node:fs';
import path from 'node:path';
import type { SpaceModel, Vec2 } from '@sdd/shared';
import { MODEL_SCHEMA_VERSION, parseComponentType, parseSpaceType } from '@sdd/shared';

const DSML_PARAM_END = /<\/｜｜DSML｜｜ parameter>/;

/** 从 DeepSeek DSML 文本中提取 Write 工具的文件路径与 JSON 内容 */
export function extractDsmlWrite(text: string): { filePath: string; content: string } | null {
  if (!text.includes('invoke name="Write"')) return null;

  const fileMatch = text.match(/parameter name="(?:file_path|file)"[^>]*>([^<]+)</);
  const contentTag = text.match(/parameter name="content"[^>]*>/);
  if (!fileMatch || !contentTag) return null;

  const start = (contentTag.index ?? 0) + contentTag[0].length;
  const rest = text.slice(start);
  const end = rest.search(DSML_PARAM_END);
  if (end < 0) return null;

  return { filePath: fileMatch[1].trim(), content: rest.slice(0, end).trim() };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  return fallback;
}

function toSwing(v: unknown): 'left' | 'right' | 'none' {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  if (s === 'left' || s === 'right' || s === 'none') return s;
  return 'left';
}

function toLeafCount(v: unknown): 1 | 2 {
  return v === 2 ? 2 : 1;
}

function toPoints(w: Record<string, unknown>): Vec2[] | null {
  const geo = asRecord(w.geometry);
  const pts = (geo?.points ?? w.points) as unknown;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  return pts as Vec2[];
}

function resolveSchemaVersion(root: Record<string, unknown>, meta: Record<string, unknown>): string {
  const fromMeta = meta.schemaVersion;
  const fromRoot = root.schemaVersion;
  if (typeof fromMeta === 'string') return fromMeta;
  if (typeof fromRoot === 'string') return fromRoot;
  if (fromMeta === 1 || fromRoot === 1) return MODEL_SCHEMA_VERSION;
  return MODEL_SCHEMA_VERSION;
}

/** 将 Agent 常见非标准 JSON 规整为 SpaceModel */
export function normalizeAgentModel(raw: unknown, revisionId: string): SpaceModel | null {
  const root = asRecord(raw);
  if (!root) return null;

  const meta = asRecord(root.model) ?? {};
  const floor = asRecord(root.floor);
  if (!floor || !Array.isArray(floor.boundary)) return null;

  const resolvedRevisionId =
    typeof meta.revisionId === 'string' && /^rev-\d+$/.test(meta.revisionId) ? meta.revisionId : revisionId;

  const model: SpaceModel = {
    model: {
      schemaVersion: resolveSchemaVersion(root, meta),
      revisionId: resolvedRevisionId,
      parentRevisionId:
        typeof meta.parentRevisionId === 'string'
          ? meta.parentRevisionId
          : meta.parentRevisionId === null
            ? null
            : null,
      units: meta.units === 'mm' ? 'mm' : 'm',
      origin: Array.isArray(meta.origin) && meta.origin.length === 2
        ? [Number(meta.origin[0]), Number(meta.origin[1])]
        : [0, 0],
    },
    floor: {
      boundary: floor.boundary as Vec2[],
      elevation: Number(floor.elevation ?? 0),
      height: Number(floor.height ?? 3),
      topObstruction: toBool(floor.topObstruction),
      bottomObstruction: toBool(floor.bottomObstruction),
    },
    spaces: [],
    walls: [],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  };

  const customTypes: SpaceModel['componentTypes'] = [];
  for (const ct of (root.componentTypes as unknown[]) ?? []) {
    const parsed = parseComponentType(ct);
    if (parsed) customTypes.push(parsed);
  }
  if (customTypes.length > 0) model.componentTypes = customTypes;

  const spaceTypes: SpaceModel['spaceTypes'] = [];
  for (const st of (root.spaceTypes as unknown[]) ?? []) {
    const parsed = parseSpaceType(st);
    if (parsed) spaceTypes.push(parsed);
  }
  if (spaceTypes.length > 0) model.spaceTypes = spaceTypes;

  for (const s of (root.spaces as unknown[]) ?? []) {
    const sp = asRecord(s);
    if (!sp || typeof sp.id !== 'string' || !Array.isArray(sp.boundary)) continue;
    const typeId = typeof sp.typeId === 'string' ? sp.typeId : '';
    model.spaces.push({
      id: sp.id,
      boundary: sp.boundary as Vec2[],
      typeId,
      usage: typeof sp.usage === 'string' ? sp.usage : typeof sp.name === 'string' ? sp.name : '房间',
      targetArea: Number(sp.targetArea ?? 0),
      performancePreferences: asRecord(sp.performancePreferences) ?? {},
    });
  }

  for (const w of (root.walls as unknown[]) ?? []) {
    const wall = asRecord(w);
    if (!wall || typeof wall.id !== 'string') continue;
    const points = toPoints(wall);
    if (!points) continue;
    const wallEntry: SpaceModel['walls'][number] = {
      id: wall.id,
      geometry: { type: 'polyline', points },
      thickness: Number(wall.thickness ?? 0.2),
      height: Number(wall.height ?? model.floor.height),
      fixed: wall.fixed === true,
    };
    const wallProps = asRecord(wall.analysisProperties);
    if (wallProps) wallEntry.analysisProperties = wallProps;
    model.walls.push(wallEntry);
  }

  for (const o of (root.openings as unknown[]) ?? []) {
    const op = asRecord(o);
    if (!op || typeof op.id !== 'string' || typeof op.hostWallId !== 'string') continue;
    model.openings.push({
      id: op.id,
      hostWallId: op.hostWallId,
      position: Number(op.position ?? 0),
      width: Number(op.width ?? 0.9),
      height: Number(op.height ?? 2.1),
      fillRef: typeof op.fillRef === 'string' ? op.fillRef : undefined,
    });
  }

  for (const d of (root.doors as unknown[]) ?? []) {
    const door = asRecord(d);
    if (!door || typeof door.id !== 'string' || typeof door.openingId !== 'string') continue;
    model.doors.push({
      id: door.id,
      openingId: door.openingId,
      swing: toSwing(door.swing),
      leafCount: toLeafCount(door.leafCount),
      analysisProperties: asRecord(door.analysisProperties) ?? {},
    });
  }

  for (const w of (root.windows as unknown[]) ?? []) {
    const win = asRecord(w);
    if (!win || typeof win.id !== 'string' || typeof win.openingId !== 'string') continue;
    model.windows.push({
      id: win.id,
      openingId: win.openingId,
      analysisProperties: asRecord(win.analysisProperties) ?? {},
    });
  }

  const fixedContextItems = Array.isArray(root.fixedContext) ? root.fixedContext : [];
  for (const item of fixedContextItems) {
    const fc = asRecord(item);
    if (!fc || typeof fc.id !== 'string' || typeof fc.kind !== 'string') continue;
    const geo = asRecord(fc.geometry);
    const pts = geo?.points;
    if (!Array.isArray(pts) || pts.length < 3) continue;
    model.fixedContext.push({
      id: fc.id,
      kind: fc.kind,
      geometry: { type: 'polyline', points: pts as Vec2[] },
      source: typeof fc.source === 'string' ? fc.source : undefined,
    });
  }

  const externalContextItems = Array.isArray(root.externalContext) ? root.externalContext : [];
  for (const item of externalContextItems) {
    const ec = asRecord(item);
    if (!ec || typeof ec.id !== 'string' || typeof ec.kind !== 'string') continue;
    const geo = asRecord(ec.geometry);
    const pts = geo?.points;
    if (!Array.isArray(pts) || pts.length < 3) continue;
    model.externalContext.push({
      id: ec.id,
      kind: ec.kind,
      geometry: { type: 'polyline', points: pts as Vec2[] },
      source: typeof ec.source === 'string' ? ec.source : undefined,
    });
  }

  return model;
}

/** 将 DSML 中的 model.json 写入指定 revision 目录 */
export function salvageDsmlToRevision(text: string, cwd: string, revisionId: string): boolean {
  const extracted = extractDsmlWrite(text);
  if (!extracted) return false;

  let raw: unknown;
  try {
    raw = JSON.parse(extracted.content);
  } catch {
    return false;
  }

  if (!raw || typeof raw !== 'object') return false;

  const dir = path.join(cwd, 'designs', revisionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(raw, null, 2));
  return true;
}
