import fs from 'node:fs';
import path from 'node:path';
import type { SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../config';

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
