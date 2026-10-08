import fs from 'node:fs';
import path from 'node:path';

const SKETCH_EXT = /\.(png|jpe?g|webp)$/i;

export function listSketchInputHints(inputsDir: string): string | undefined {
  if (!fs.existsSync(inputsDir)) return undefined;
  const names = fs.readdirSync(inputsDir).filter((name) => name !== 'outline.json' && SKETCH_EXT.test(name));
  if (!names.length) return undefined;
  return names.map((name) => `inputs/${name}`).join('、');
}

export function isSketchFilename(name: string): boolean {
  return SKETCH_EXT.test(name);
}

export function isDxfFilename(name: string): boolean {
  return /\.dxf$/i.test(name);
}

export function mimeForInputFile(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.dxf') return 'application/dxf';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}
