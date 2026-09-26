import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { workspacesDir } from '../config';

export const uploadsRouter = Router();

function inputsDir(sessionId: string): string {
  return path.join(workspacesDir, sessionId, 'inputs');
}

function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\-]+/g, '_');
}

uploadsRouter.post('/uploads', (req, res) => {
  const body = (req.body ?? {}) as {
    sessionId?: unknown;
    filename?: unknown;
    contentBase64?: unknown;
  };
  const { sessionId, filename, contentBase64 } = body;

  if (typeof filename !== 'string' || !filename.trim()) {
    res.status(400).json({ error: 'filename required' });
    return;
  }
  if (typeof contentBase64 !== 'string' || !contentBase64) {
    res.status(400).json({ error: 'contentBase64 required' });
    return;
  }

  const id = typeof sessionId === 'string' && sessionId ? sessionId : randomUUID();
  const name = safeName(filename);
  const dir = inputsDir(id);
  fs.mkdirSync(dir, { recursive: true });

  let content: Buffer;
  try {
    content = Buffer.from(contentBase64, 'base64');
  } catch {
    res.status(400).json({ error: 'invalid base64' });
    return;
  }

  fs.writeFileSync(path.join(dir, name), content);
  res.json({ sessionId: id, file: { name, size: content.length } });
});

uploadsRouter.get('/files/:sessionId/:name', (req, res) => {
  const { sessionId, name } = req.params;
  const dir = inputsDir(sessionId);
  const file = path.join(dir, safeName(name));
  if (!file.startsWith(dir + path.sep)) {
    res.status(400).json({ error: 'invalid name' });
    return;
  }
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('text/plain').sendFile(file);
});
