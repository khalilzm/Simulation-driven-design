import fs from 'node:fs';
import path from 'node:path';

/** 在 inputs/ 下找最近修改的草图图片（png/jpg/webp）。 */
export function findSketchImagePath(cwd: string): string | null {
  const inputsDir = path.join(cwd, 'inputs');
  if (!fs.existsSync(inputsDir)) return null;
  const names = fs.readdirSync(inputsDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
  if (!names.length) return null;
  names.sort((a, b) => fs.statSync(path.join(inputsDir, b)).mtimeMs - fs.statSync(path.join(inputsDir, a)).mtimeMs);
  return path.join(inputsDir, names[0]);
}
