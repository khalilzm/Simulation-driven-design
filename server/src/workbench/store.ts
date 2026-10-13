import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canvasSnapshotModules, validateCanvasSnapshot, type WorkspaceCanvasDocument } from '@sdd/shared';
import { workspacesDir } from '../config';

function documentPath(sessionId: string, root: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw new Error('会话标识无效');
  return path.join(root, sessionId, 'canvas.json');
}

export function loadCanvas(sessionId: string, root = workspacesDir): WorkspaceCanvasDocument | null {
  const file = documentPath(sessionId, root);
  if (!fs.existsSync(file)) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkspaceCanvasDocument;
  if (![1, 2].includes(saved.schemaVersion) || validateCanvasSnapshot(saved.snapshot)) throw new Error('保存的画布文档无效');
  return saved;
}

export function saveCanvas(sessionId: string, snapshot: unknown, root = workspacesDir): WorkspaceCanvasDocument {
  const file = documentPath(sessionId, root);
  const error = validateCanvasSnapshot(snapshot);
  if (error) throw new Error(error);
  const document: WorkspaceCanvasDocument = { schemaVersion: 2, snapshot: snapshot as Record<string, unknown>, activeModules: canvasSnapshotModules(snapshot), updatedAt: new Date().toISOString() };
  const json = JSON.stringify(document);
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('画布文档超过 2 MB');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, json); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  return document;
}
