import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, sketchRunnerScript } from '../config';

export type SketchParseResult =
  | { ok: true; previewRel: string; layout: Record<string, unknown> }
  | { ok: false; error: string };

function execPython(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const scriptDir = path.dirname(sketchRunnerScript);
    const child = spawn(config.sketchPython, args, {
      cwd,
      shell: false,
      env: { ...process.env, PYTHONPATH: scriptDir },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

export function findSketchImagePath(cwd: string): string | null {
  const inputsDir = path.join(cwd, 'inputs');
  if (!fs.existsSync(inputsDir)) return null;
  const names = fs.readdirSync(inputsDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
  if (!names.length) return null;
  names.sort((a, b) => fs.statSync(path.join(inputsDir, b)).mtimeMs - fs.statSync(path.join(inputsDir, a)).mtimeMs);
  return path.join(inputsDir, names[0]);
}

/** 草图 → outline.json + 预览图 + layout 草案（秒级，不调用 Cursor Agent）。 */
export async function runSketchParse(cwd: string): Promise<SketchParseResult> {
  const imagePath = findSketchImagePath(cwd);
  if (!imagePath) return { ok: false, error: '未找到草图文件' };
  const inputsDir = path.join(cwd, 'inputs');
  const args = [
    path.resolve(sketchRunnerScript),
    '--image', imagePath,
    '--out-dir', inputsDir,
  ];
  const { stdout, stderr, exitCode } = await execPython(args, cwd);
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    const parsed = JSON.parse(line) as { ok?: boolean; error?: string; previewPath?: string; layout?: Record<string, unknown> };
    if (!parsed.ok || !parsed.layout || !parsed.previewPath) {
      return { ok: false, error: parsed.error ?? stderr.trim() ?? `sketch 解析失败 exit ${exitCode}` };
    }
    return { ok: true, previewRel: parsed.previewPath, layout: parsed.layout };
  } catch {
    return { ok: false, error: stderr.trim() || stdout.trim() || 'sketch 解析无 JSON 输出' };
  }
}

export function sketchPythonCheck(): Promise<{ ok: boolean; error?: string }> {
  const cwd = path.dirname(sketchRunnerScript);
  return execPython(['-c', 'import cv2'], cwd).then(({ exitCode, stderr }) =>
    exitCode === 0 ? { ok: true } : { ok: false, error: stderr || 'import cv2 失败' });
}
