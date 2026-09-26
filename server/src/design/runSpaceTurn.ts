import fs from 'node:fs';
import path from 'node:path';
import type { StreamEvent } from '@sdd/shared';
import { buildSpacePrompt, buildValidationCorrectionMessage, type OutlineContext } from '../spacePrompt';
import type { ProviderAdapter, TurnResult } from '../providers/types';
import { extractDsmlWrite } from '../providers/dsmlSalvage';
import { validateAgentModel } from '../model/validateAgent';
import { validateModel } from '../model/validate';
import { validateLayoutCompleteness } from '../model/layoutValidation';
import { checkOutlinePreserved } from '../model/store';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { createRegionCatalog } from './layoutRegions';
import { compileAllocation } from './compileAllocation';

interface SpaceTurnInput {
  cwd: string; revisionId: string; message: string; outline: OutlineContext;
  nativeSessionId?: string; model?: string; requireDesign?: boolean;
}

/** Agent 只提交分配；只有通过编译和校验的几何才能成为 model.json。 */
export async function runSpaceTurn(input: SpaceTurnInput, adapter: ProviderAdapter,
  emit: (event: StreamEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
  const { cwd, revisionId } = input;
  const folder = path.join(cwd, 'designs', revisionId);
  const layoutPath = path.join(folder, 'layout.json');
  const modelPath = path.join(folder, 'model.json');
  const outline = { ...input.outline };
  const started = Date.now();
  if (outline.outline) {
    outline.regions = createRegionCatalog(outline.outline, outline.currentModel);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: false, status: 'pending' }));
    emit({ type: 'progress', message: `已准备 ${outline.regions.regions.length} 个轮廓内可用区域` });
  }
  const preparationMs = Date.now() - started;
  const systemPrompt = buildSpacePrompt(revisionId, outline);
  let nativeSessionId = input.nativeSessionId;
  let message = input.message;
  let accepted = false;
  let errors: string[] = [];
  const quarantineAgentModel = () => {
    if (!fs.existsSync(modelPath)) return false;
    fs.renameSync(modelPath, path.join(folder, 'agent-model.rejected.json'));
    return true;
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) return { nativeSessionId, failed: true };
      if (attempt) emit({ type: 'progress', message: '区域分配未通过，正在修正（最多一次）…' });
      let turnText = '', hadError = false;
      const result = await adapter.run({ cwd, message, nativeSessionId, model: input.model, systemPrompt }, (event) => {
        if (event.type === 'text') turnText += event.text;
        if (event.type === 'error') hadError = true;
        emit(event);
      }, signal);
      nativeSessionId = result.nativeSessionId ?? nativeSessionId;
      const wroteGeometry = quarantineAgentModel();
      if (result.failed || hadError || signal?.aborted) return { nativeSessionId, failed: true };
      if (!outline.regions) return { nativeSessionId, failed: Boolean(input.requireDesign) };
      if (!fs.existsSync(layoutPath)) {
        const extracted = extractDsmlWrite(turnText);
        if (extracted && path.basename(extracted.filePath) === 'layout.json') fs.writeFileSync(layoutPath, extracted.content);
      }
      if (!fs.existsSync(layoutPath) && !wroteGeometry && !input.requireDesign && attempt === 0) return { nativeSessionId, failed: false };
      errors = [];
      let output: string | undefined;
      try {
        if (wroteGeometry) errors.push('检测到直接写入 model.json；请改为写 layout.json，只提交 splits 和 allocations，不能自行生成几何');
        if (!fs.existsSync(layoutPath)) errors.push(`未生成 designs/${revisionId}/layout.json，请按区域分配契约提交`);
        else {
          output = fs.readFileSync(layoutPath, 'utf8');
          const compiledAt = Date.now();
          const { model, warnings, assumptions } = compileAllocation(JSON.parse(output), outline.regions, revisionId, outline.requireFullCoverage);
          errors.push(...validateAgentModel(model).errors, ...validateModel(model).errors);
          if (outline.currentModel) {
            const error = checkOutlinePreserved(normalizeAgentGeometry(outline.currentModel), model);
            if (error) errors.push(error);
          }
          if (!errors.length) errors.push(...validateLayoutCompleteness(model, outline.requireFullCoverage));
          if (!errors.length) {
            fs.writeFileSync(`${modelPath}.tmp`, JSON.stringify(model, null, 2));
            fs.renameSync(`${modelPath}.tmp`, modelPath);
            fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: true, status: 'accepted',
              preparationMs, compilationMs: Date.now() - compiledAt, elapsedMs: Date.now() - started,
              attempts: attempt + 1, regionCount: outline.regions.regions.length, warnings, assumptions }, null, 2));
            accepted = true;
            emit({ type: 'design', revisionId, valid: true, errors: [], warnings });
            return { nativeSessionId, failed: false };
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      errors = [...new Set(errors)];
      if (attempt === 0) message = buildValidationCorrectionMessage(revisionId, errors, output);
      else emit({ type: 'design', revisionId, valid: false, errors });
    }
    return { nativeSessionId, failed: true };
  } finally {
    if (outline.regions && !accepted) {
      quarantineAgentModel();
      fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: false, status: 'rejected', errors }, null, 2));
    }
  }
}
