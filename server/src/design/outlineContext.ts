import fs from 'node:fs';
import path from 'node:path';
import type { SpaceModel } from '@sdd/shared';
import { extractDxfOutline } from '../dxf/outline';
import { buildOutlineJson, outlineToText, type OutlineContext } from '../spacePrompt';

export function loadOutlineContext(cwd: string, parent: SpaceModel | null): OutlineContext {
  if (parent) return { source: 'parent', outline: outlineToText(parent), currentModel: parent };
  const inputsDir = path.join(cwd, 'inputs');
  if (!fs.existsSync(inputsDir)) return { source: 'none' };
  const files = fs.readdirSync(inputsDir).filter((name) => /\.dxf$/i.test(name))
    .sort((a, b) => fs.statSync(path.join(inputsDir, b)).mtimeMs - fs.statSync(path.join(inputsDir, a)).mtimeMs);
  for (const file of files) {
    try {
      const outline = extractDxfOutline(fs.readFileSync(path.join(inputsDir, file), 'utf8'));
      if (outline) return { source: 'dxf', outline: buildOutlineJson(outline) };
    } catch {
      // 尝试其他输入；无可用轮廓时由提示词解释原因。
    }
  }
  return { source: 'none' };
}

/** 只识别明确的覆盖要求；后续局部修改沿用已确认的选择。 */
export function resolveFullCoverage(message: string, previous = false): boolean {
  const pattern = /(?:不用|不必|无需|不要求|不需要|不要)(?:全部|完全)?(?:铺满|填满|全覆盖|覆盖)|(?:允许|保留|可以)(?:部分)?(?:留白|空白|未分配区域)|allow gaps|partial coverage|铺满|填满|全覆盖|无\s*void|不留空白|无空白|full coverage|no gaps/gi;
  let required = previous;
  for (const match of message.matchAll(pattern)) {
    required = !/^(?:不用|不必|无需|不要求|不需要|不要|允许|保留|可以|allow|partial)/i.test(match[0]);
  }
  return required;
}
