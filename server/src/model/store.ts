import fs from 'node:fs';
import path from 'node:path';
import type { PedestrianConfig, SpaceModel, SunlightConfig } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';
import { parsePedestrianConfig, parseSunlightConfig } from '@sdd/shared';
import { workspacesDir } from '../config';
import { validateStoredDesign } from './designValidity';

function designsDir(sessionId: string): string {
  return path.join(workspacesDir, sessionId, 'designs');
}

function parseRev(name: string): number | null {
  const m = /^rev-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

export function nextRevisionId(sessionId: string): string {
  const dir = designsDir(sessionId);
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      const n = parseRev(entry);
      if (n !== null && n > max) max = n;
    }
  }
  return `rev-${String(max + 1).padStart(4, '0')}`;
}

export function loadDesign(sessionId: string, revisionId: string): SpaceModel | null {
  const file = path.join(designsDir(sessionId), revisionId, 'model.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as SpaceModel;
  } catch {
    return null;
  }
}

export interface DesignSummary {
  revisionId: string;
  parentRevisionId: string | null;
  createdAt: string;
  valid: boolean;
  kind: 'dxf' | 'scheme';
  baseRevisionId?: string;
  briefVersion?: number;
  sketchId?: string;
  sketchStatus?: SpaceModel['model']['sketchStatus'];
}

export function isAcceptedDesign(sessionId: string, revisionId: string, model?: SpaceModel): boolean {
  const loaded = model ?? loadDesign(sessionId, revisionId);
  const file = path.join(designsDir(sessionId), revisionId, 'validation.json');
  if (fs.existsSync(file)) {
    try {
      const v = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        valid?: boolean;
        geometryValid?: boolean;
        status?: string;
      };
      if (v.valid === true) return validateStoredDesign(loaded).valid;
      if (
        !SKETCH_HUMAN_REVIEW_ENABLED &&
        loaded?.model.sketchId &&
        v.geometryValid === true &&
        v.status !== 'rejected'
      ) {
        return validateStoredDesign(loaded).valid;
      }
      return false;
    } catch { return false; }
  }
  return validateStoredDesign(loaded).valid;
}

export function listDesigns(sessionId: string): DesignSummary[] {
  const dir = designsDir(sessionId);
  if (!fs.existsSync(dir)) return [];
  const out: DesignSummary[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (parseRev(entry) === null) continue;
    const model = loadDesign(sessionId, entry);
    if (!model) continue;
    let createdAt = '';
    try {
      createdAt = fs.statSync(path.join(dir, entry, 'model.json')).mtime.toISOString();
    } catch {
      // 忽略时间戳读取失败
    }
    out.push({
      revisionId: entry,
      parentRevisionId: model.model?.parentRevisionId ?? null,
      createdAt,
      valid: isAcceptedDesign(sessionId, entry, model),
      kind: model.model?.dxfSource && !model.spaces?.length ? 'dxf' : 'scheme',
      baseRevisionId: model.model?.residentialBrief?.baseRevisionId,
      briefVersion: model.model?.residentialBrief?.version,
      sketchId: model.model?.sketchId,
      sketchStatus: model.model?.sketchStatus,
    });
  }
  return out.sort((a, b) => a.revisionId.localeCompare(b.revisionId));
}

export function checkFixedPreserved(parent: SpaceModel, child: SpaceModel): string | null {
  const parentFixed = new Map(parent.walls.filter((w) => w.fixed).map((w) => [w.id, w]));
  for (const w of child.walls) {
    if (!w.fixed) continue;
    const p = parentFixed.get(w.id);
    if (!p) return `fixed wall ${w.id} 在父版本中不存在`;
    if (JSON.stringify(p.geometry) !== JSON.stringify(w.geometry)) {
      return `fixed wall ${w.id} 的几何被修改`;
    }
  }
  return null;
}

/** 外轮廓（floor.boundary + fixed 墙）必须与父版本完全一致 */
export function checkOutlinePreserved(parent: SpaceModel, child: SpaceModel): string | null {
  if (JSON.stringify(parent.floor.boundary) !== JSON.stringify(child.floor.boundary)) {
    return 'floor 外轮廓（boundary）被修改';
  }
  const err = checkFixedPreserved(parent, child);
  if (err) return err;
  for (const p of parent.walls) {
    if (!p.fixed) continue;
    if (!child.walls.some((w) => w.id === p.id && w.fixed)) {
      return `fixed wall ${p.id} 在子版本中缺失`;
    }
  }
  return null;
}

export function saveDesign(
  sessionId: string,
  model: SpaceModel,
  parentRevisionId?: string,
): { revisionId: string } {
  if (!model.model || typeof model.model !== 'object') {
    throw new Error('model 缺少 model 元信息');
  }
  if (parentRevisionId) {
    const parent = loadDesign(sessionId, parentRevisionId);
    if (!parent) throw new Error(`parent revision 不存在: ${parentRevisionId}`);
    const err = checkOutlinePreserved(parent, model);
    if (err) throw new Error(err);
  }

  const revisionId = nextRevisionId(sessionId);
  const saved = structuredClone(model);
  saved.model.revisionId = revisionId;
  saved.model.parentRevisionId = parentRevisionId ?? null;

  const dir = path.join(designsDir(sessionId), revisionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'model.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(saved, null, 2));
  fs.renameSync(tmp, file);

  return { revisionId };
}

export function loadSunlightConfig(
  sessionId: string,
  revisionId: string,
): { ok: true; config: SunlightConfig } | { ok: false; errors: string[] } | null {
  const file = path.join(designsDir(sessionId), revisionId, 'sunlight.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = parseSunlightConfig(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return { ok: true, config: parsed.config };
  } catch {
    return { ok: false, errors: ['sunlight.json 无法解析'] };
  }
}

export function saveSunlightConfig(
  sessionId: string,
  revisionId: string,
  raw: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const parsed = parseSunlightConfig(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const dir = path.join(designsDir(sessionId), revisionId);
  if (!fs.existsSync(path.join(dir, 'model.json'))) {
    return { ok: false, errors: [`方案不存在: ${revisionId}`] };
  }
  const file = path.join(dir, 'sunlight.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { ok: true };
}

export function loadPedestrianConfig(
  sessionId: string,
  revisionId: string,
): { ok: true; config: PedestrianConfig } | { ok: false; errors: string[] } | null {
  const file = path.join(designsDir(sessionId), revisionId, 'pedestrian.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const parsed = parsePedestrianConfig(raw);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return { ok: true, config: parsed.config };
  } catch {
    return { ok: false, errors: ['pedestrian.json 无法解析'] };
  }
}

export function savePedestrianConfig(
  sessionId: string,
  revisionId: string,
  raw: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  const parsed = parsePedestrianConfig(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const dir = path.join(designsDir(sessionId), revisionId);
  if (!fs.existsSync(path.join(dir, 'model.json'))) {
    return { ok: false, errors: [`方案不存在: ${revisionId}`] };
  }
  const file = path.join(dir, 'pedestrian.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { ok: true };
}

function writeModelJson(sessionId: string, revisionId: string, model: SpaceModel): void {
  const file = path.join(designsDir(sessionId), revisionId, 'model.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(model, null, 2));
  fs.renameSync(tmp, file);
}

export interface DesignFloorPatch {
  elevation: number;
  height: number;
}

/** 就地更新本版 model.json 的楼层标高/层高（供日照等分析使用，不新建 revision） */
export function updateDesignFloor(
  sessionId: string,
  revisionId: string,
  patch: DesignFloorPatch,
): { ok: true } | { ok: false; errors: string[] } {
  const { elevation, height } = patch;
  if (!Number.isFinite(elevation)) {
    return { ok: false, errors: ['floor.elevation 须为有限数值'] };
  }
  if (!Number.isFinite(height) || height <= 0) {
    return { ok: false, errors: ['floor.height 须为大于 0 的有限数值'] };
  }
  const model = loadDesign(sessionId, revisionId);
  if (!model) {
    return { ok: false, errors: [`方案不存在: ${revisionId}`] };
  }
  const next = structuredClone(model);
  next.floor.elevation = elevation;
  next.floor.height = height;
  const validation = validateStoredDesign(next);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors };
  }
  writeModelJson(sessionId, revisionId, next);
  return { ok: true };
}
