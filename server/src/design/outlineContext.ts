import fs from 'node:fs';
import path from 'node:path';
import type { SpaceModel } from '@sdd/shared';
import { buildOutlineJson, outlineToText, type OutlineContext } from '../spacePrompt';
import { listSketchInputHints } from './inputHints';
import { loadProgramOutlineFile } from './programOutline';

export function loadOutlineContext(cwd: string, parent: SpaceModel | null, lenient = false): OutlineContext {
  if (parent) return { source: 'parent', outline: outlineToText(parent), currentModel: parent };
  const inputsDir = path.join(cwd, 'inputs');
  if (fs.existsSync(inputsDir)) {
    const program = loadProgramOutlineFile(path.join(inputsDir, 'outline.json'), lenient);
    if (program) {
      return { source: 'program', outline: program.outlineJson, inputHints: listSketchInputHints(inputsDir) };
    }
    const hints = listSketchInputHints(inputsDir);
    if (hints) return { source: 'none', inputHints: hints };
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
