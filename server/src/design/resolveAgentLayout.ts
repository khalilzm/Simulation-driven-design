import fs from 'node:fs';
import path from 'node:path';
import { PROGRAM_OUTLINE_REL } from './programOutline';

/** 本会话内 Agent 应写入的 layout 相对路径（相对 cwd）。 */
export function layoutRelativePath(revisionId: string): string {
  return path.join('designs', revisionId, 'layout.json');
}

/** 在 cwd 之外查找误写的 designs/<revisionId>/layout.json（如写到仓库根 designs/）。 */
export function findMisplacedLayoutFile(cwd: string, revisionId: string): string | null {
  const expected = path.resolve(cwd, layoutRelativePath(revisionId));
  const rel = layoutRelativePath(revisionId);
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 10; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, rel);
    if (candidate === expected || !fs.existsSync(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * 确保 layout 落在 cwd/designs/<revisionId>/layout.json。
 * 若 Agent 写到仓库其它目录，复制到正确位置并返回说明（仍建议 Agent 下次直接写相对路径）。
 */
export function ensureAgentLayoutFile(
  cwd: string,
  revisionId: string,
  writeContent?: string,
): { ok: true; recoveredFrom?: string } | { ok: false; reason: string } {
  const target = path.resolve(cwd, layoutRelativePath(revisionId));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (writeContent !== undefined) {
    fs.writeFileSync(target, writeContent);
    return { ok: true };
  }
  if (fs.existsSync(target)) return { ok: true };
  const misplaced = findMisplacedLayoutFile(cwd, revisionId);
  if (!misplaced) {
    return { ok: false, reason: `未生成 ${layoutRelativePath(revisionId)}，请在本会话工作目录内写入该相对路径（勿写仓库根或其它 session 的 designs/）` };
  }
  fs.copyFileSync(misplaced, target);
  return { ok: true, recoveredFrom: misplaced };
}

function findMisplacedOutlineFile(cwd: string): string | null {
  const expected = path.resolve(cwd, PROGRAM_OUTLINE_REL);
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 10; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, PROGRAM_OUTLINE_REL);
    if (candidate === expected || !fs.existsSync(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/** 确保 inputs/outline.json 落在会话 cwd 内（可从误写路径复制）。 */
export function ensureAgentOutlineFile(
  cwd: string,
  writeContent?: string,
): { ok: true; recoveredFrom?: string } | { ok: false; reason: string } {
  const target = path.resolve(cwd, PROGRAM_OUTLINE_REL);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (writeContent !== undefined) {
    fs.writeFileSync(target, writeContent);
    return { ok: true };
  }
  if (fs.existsSync(target)) return { ok: true };
  const misplaced = findMisplacedOutlineFile(cwd);
  if (!misplaced) {
    return { ok: false, reason: `未生成 ${PROGRAM_OUTLINE_REL}；纯文本方案须先写入该文件再写 layout.json` };
  }
  fs.copyFileSync(misplaced, target);
  return { ok: true, recoveredFrom: misplaced };
}

/** 本会话内 Agent 应写入的 intent 相对路径（相对 cwd）。 */
export function intentRelativePath(revisionId: string): string {
  return path.join('designs', revisionId, 'intent.json');
}

/** 在 cwd 之外查找误写的 intent.json（如写到仓库根 designs/）。 */
export function findMisplacedIntentFile(cwd: string, revisionId: string): string | null {
  const expected = path.resolve(cwd, intentRelativePath(revisionId));
  const rel = intentRelativePath(revisionId);
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 10; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const candidate = path.join(dir, rel);
    if (candidate === expected || !fs.existsSync(candidate)) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

/** 确保 intent.json 落在 cwd/designs/<revisionId>/intent.json（可从误写路径复制）。 */
export function ensureAgentIntentFile(
  cwd: string,
  revisionId: string,
  writeContent?: string,
): { ok: true; recoveredFrom?: string } | { ok: false; reason: string } {
  const target = path.resolve(cwd, intentRelativePath(revisionId));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (writeContent !== undefined) {
    fs.writeFileSync(target, writeContent);
    return { ok: true };
  }
  if (fs.existsSync(target)) return { ok: true };
  const misplaced = findMisplacedIntentFile(cwd, revisionId);
  if (!misplaced) {
    return { ok: false, reason: `未生成 ${intentRelativePath(revisionId)}，请在本会话工作目录内写入该相对路径（勿写仓库根或其它 session 的 designs/）` };
  }
  fs.copyFileSync(misplaced, target);
  return { ok: true, recoveredFrom: misplaced };
}
