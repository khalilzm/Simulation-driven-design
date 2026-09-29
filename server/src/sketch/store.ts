import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SketchSource } from '@sdd/shared';

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

export async function saveSketch(cwd: string, originalName: string, bytes: Buffer): Promise<SketchSource> {
  const started = performance.now();
  const decoded = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
  const metadata = await decoded.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('图片内容必须是 PNG、JPEG 或 WebP');
  const id = `sketch-${randomUUID()}`;
  // Remove EXIF orientation, resize once, and use this exact PNG in both model input and overlay.
  const { data, info } = await decoded.rotate().resize({ width: 3000, height: 3000, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true });
  const source: SketchSource = {
    id, originalName,
    originalPath: `inputs/${id}-original.${metadata.format === 'jpeg' ? 'jpg' : metadata.format}`,
    imagePath: `inputs/${id}.png`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: info.width, height: info.height, createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(cwd, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(cwd, source.originalPath), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(cwd, source.imagePath), data, { flag: 'wx' });
  source.preparationMs = Math.round((performance.now() - started) * 1000) / 1000;
  writeJson(path.join(cwd, 'inputs', `${id}.json`), source);
  writeJson(path.join(cwd, 'inputs', 'active-sketch.json'), { id });
  return source;
}

export function loadSketch(cwd: string, id?: string): SketchSource | null {
  try {
    const selected = id ?? JSON.parse(fs.readFileSync(path.join(cwd, 'inputs/active-sketch.json'), 'utf8')).id;
    if (typeof selected !== 'string' || !/^sketch-[a-f0-9-]{36}$/.test(selected)) return null;
    const source = JSON.parse(fs.readFileSync(path.join(cwd, 'inputs', `${selected}.json`), 'utf8')) as SketchSource;
    if (source.id !== selected || source.imagePath !== `inputs/${selected}.png` || !fs.existsSync(path.join(cwd, source.imagePath))) return null;
    return source;
  } catch { return null; }
}

/** Snapshot pre-versioning uploads once; generated previews are not source images. */
export async function resolveSketch(cwd: string, id?: string): Promise<SketchSource | null> {
  const source = loadSketch(cwd, id);
  if (source || id !== undefined) return source;
  const inputs = path.join(cwd, 'inputs');
  if (!fs.existsSync(inputs)) return null;
  const names = fs.readdirSync(inputs).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)
    && !/^sketch-(?:preview|[a-f0-9-]{36})/i.test(name));
  names.sort((a, b) => fs.statSync(path.join(inputs, b)).mtimeMs - fs.statSync(path.join(inputs, a)).mtimeMs);
  if (!names.length) return null;
  return saveSketch(cwd, names[0], fs.readFileSync(path.join(inputs, names[0])));
}
