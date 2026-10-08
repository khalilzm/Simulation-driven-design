import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import { workspacesDir } from '../config';
import { isDxfFilename, isSketchFilename, mimeForInputFile } from '../design/inputHints';
import { saveSketch } from '../sketch/store';
import { parseFixedEnvelopeDxf } from '../dxf/fixedEnvelope';
import { loadDesign, saveDesign } from '../model/store';

export const uploadsRouter = Router();

function inputsDir(sessionId: string): string {
  return path.join(workspacesDir, sessionId, 'inputs');
}

function safeName(name: string): string {
  return path.basename(name).replace(/[^\w.\-]+/g, '_');
}

export async function handleUpload(req: Request, res: Response): Promise<void> {
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
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) { res.status(400).json({ error: 'invalid sessionId' }); return; }
  const name = safeName(filename);
  if (!isSketchFilename(name) && !isDxfFilename(name)) {
    res.status(400).json({ error: '支持住宅 DXF 底图，或 PNG、JPEG、WebP 草图' });
    return;
  }
  const dir = inputsDir(id);
  fs.mkdirSync(dir, { recursive: true });

  let content: Buffer;
  try {
    content = Buffer.from(contentBase64, 'base64');
  } catch {
    res.status(400).json({ error: 'invalid base64' });
    return;
  }

  try {
    if (isDxfFilename(name)) {
      const parsed = parseFixedEnvelopeDxf(content.toString('utf8'), filename);
      const storedName = `dxf-${randomUUID()}.dxf`;
      fs.writeFileSync(path.join(dir, storedName), content);
      const { revisionId } = saveDesign(id, parsed);
      res.json({ sessionId: id, file: { name: storedName, size: content.length }, revisionId, model: loadDesign(id, revisionId) });
      return;
    }
    const sketch = await saveSketch(path.join(workspacesDir, id), filename, content);
    res.json({ sessionId: id, file: { name: path.basename(sketch.imagePath), size: content.length }, sketch });
  } catch (error) {
    res.status(400).json({ error: `无法读取${isDxfFilename(name) ? ' DXF' : '图片'}：${error instanceof Error ? error.message : String(error)}` });
  }
}

uploadsRouter.post('/uploads', handleUpload);

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
  res.type(mimeForInputFile(name)).sendFile(file);
});
