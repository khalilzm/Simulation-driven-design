import fs from 'node:fs';
import path from 'node:path';
import { workspacesDir } from '../config';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: string;
}

export interface SessionRecord {
  sessionId: string;
  provider: string;
  nativeSessionId?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function dirFor(id: string): string {
  return path.join(workspacesDir, id);
}

function fileFor(id: string): string {
  return path.join(dirFor(id), 'session.json');
}

export function loadSession(id: string): SessionRecord | null {
  try {
    return JSON.parse(fs.readFileSync(fileFor(id), 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

export function saveSession(rec: SessionRecord): void {
  const dir = dirFor(rec.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(rec.sessionId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

export function createSession(id: string, provider: string): SessionRecord {
  const now = new Date().toISOString();
  return { sessionId: id, provider, messages: [], createdAt: now, updatedAt: now };
}
