import fs from 'node:fs';
import path from 'node:path';
import type { StreamEvent } from '@sdd/shared';
import { buildOutlineJson, buildSpacePrompt, buildValidationCorrectionMessage, type OutlineContext } from '../spacePrompt';
import type { ProviderAdapter, TurnResult } from '../providers/types';
import { extractDsmlWrite } from '../providers/dsmlSalvage';
import { validateAgentModel } from '../model/validateAgent';
import { validateModel } from '../model/validate';
import { validateLayoutCompleteness } from '../model/layoutValidation';
import { checkOutlinePreserved } from '../model/store';
import { normalizeAgentGeometry } from '../model/normalizeAgent';
import { createLayoutContext } from './layoutContext';
import { compileLayout } from './compileLayout';
import { buildIntentPrompt, buildIntentOnlyPrompt } from './spaceAgentPrompts';
import { ensureAgentIntentFile, ensureAgentLayoutFile, intentRelativePath, layoutRelativePath } from './resolveAgentLayout';
import { parseDesignIntent } from './intent';
import { compileIntent, deriveOutline } from './layoutIntent';

interface SpaceTurnInput {
  cwd: string; revisionId: string; message: string; outline: OutlineContext;
  nativeSessionId?: string; model?: string; requireDesign?: boolean;
}

const LAYOUT_ATTEMPTS = 3;

function ensureDesignFolderPending(folder: string): void {
  fs.mkdirSync(folder, { recursive: true });
  const validationPath = path.join(folder, 'validation.json');
  if (!fs.existsSync(validationPath)) {
    fs.writeFileSync(validationPath, JSON.stringify({ valid: false, status: 'pending' }));
  }
}

function buildIntentCorrectionMessage(revisionId: string, errors: string[], currentOutput?: string): string {
  return [
    `designs/${revisionId}/intent.json 校验未通过。请按 schemaVersion 1 写设计意图（rooms/adjacencies/daylight，不含几何坐标）。`,
    ...errors.map((error, i) => `${i + 1}. ${error}`),
    ...(currentOutput ? ['', '当前文件内容：', currentOutput] : []),
    '保留无关 id，简述修正。',
  ].join('\n');
}

function failNoDeliverable(
  revisionId: string,
  errors: string[],
  requireDesign: boolean | undefined,
  emit: (event: StreamEvent) => void,
  nativeSessionId: string | undefined,
): TurnResult {
  if (requireDesign !== false) {
    emit({ type: 'design', revisionId, valid: false, errors });
  }
  return { nativeSessionId, failed: requireDesign !== false };
}

/** 文字意图或已有布局 → model.json；草图走独立 runSketchTurn。 */
export async function runSpaceTurn(input: SpaceTurnInput, adapter: ProviderAdapter,
  emit: (event: StreamEvent) => void, signal?: AbortSignal): Promise<TurnResult> {
  const { cwd, revisionId } = input;
  const folder = path.join(cwd, 'designs', revisionId);
  const layoutPath = path.join(folder, 'layout.json');
  const intentPath = path.join(folder, 'intent.json');
  const modelPath = path.join(folder, 'model.json');
  const outline = { ...input.outline };
  const requireDesign = input.requireDesign !== false;
  const isParentTurn = !!outline.currentModel;
  const useLayout = isParentTurn;
  const started = Date.now();
  if (outline.outline) {
    outline.layout = createLayoutContext(outline.outline, outline.currentModel);
    outline.workspaceDir = cwd;
    ensureDesignFolderPending(folder);
    emit({ type: 'progress', message: '已加载外轮廓，等待 layout.json' });
  } else {
    ensureDesignFolderPending(folder);
    emit({ type: 'progress', message: '第 1 步：根据描述生成外轮廓 outline.json…' });
  }
  const preparationMs = Date.now() - started;
  let nativeSessionId = input.nativeSessionId;
  let message = input.message;
  let accepted = false;
  let errors: string[] = [];
  const quarantineAgentModel = () => {
    if (!fs.existsSync(modelPath)) return false;
    fs.renameSync(modelPath, path.join(folder, 'agent-model.rejected.json'));
    return true;
  };

  const tryCompileLayoutFile = (attempt: number): boolean => {
    errors = [];
    try {
      if (!fs.existsSync(layoutPath)) {
        errors.push(`未生成 ${layoutRelativePath(revisionId)}`);
        return false;
      }
      const output = fs.readFileSync(layoutPath, 'utf8');
      const compiledAt = Date.now();
      const { model, warnings, assumptions } = compileLayout(
        JSON.parse(output), outline.layout!, revisionId, outline.requireFullCoverage,
      );
      {
        errors.push(...validateAgentModel(model).errors, ...validateModel(model).errors);
        if (outline.currentModel) {
          const error = checkOutlinePreserved(normalizeAgentGeometry(outline.currentModel), model);
          if (error) errors.push(error);
        }
        if (!errors.length) errors.push(...validateLayoutCompleteness(model, outline.requireFullCoverage));
      }
      if (errors.length) return false;
      fs.writeFileSync(`${modelPath}.tmp`, JSON.stringify(model, null, 2));
      fs.renameSync(`${modelPath}.tmp`, modelPath);
      fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({
        valid: true, status: 'accepted',
        preparationMs, compilationMs: Date.now() - compiledAt, elapsedMs: Date.now() - started,
        attempts: attempt, warnings, assumptions,
      }, null, 2));
      accepted = true;
      emit({ type: 'design', revisionId, valid: true, errors: [], warnings });
      return true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const tryCompileIntentFile = (attempt: number): boolean => {
    errors = [];
    try {
      if (!fs.existsSync(intentPath)) {
        errors.push(`未生成 ${intentRelativePath(revisionId)}`);
        return false;
      }
      const raw = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
      const parsed = parseDesignIntent(raw);
      if (!parsed.ok) {
        errors.push(...parsed.errors);
        return false;
      }
      const compiledAt = Date.now();
      const layout = outline.layout ?? (() => {
        const derived = deriveOutline(parsed.intent);
        return createLayoutContext(buildOutlineJson({ boundary: derived.boundary, origin: [0, 0], bbox: derived.bbox }), undefined);
      })();
      const { model, warnings, assumptions } = compileIntent(parsed.intent, layout, revisionId, outline.requireFullCoverage);
      errors.push(...validateModel(model).errors);
      if (errors.length) return false;
      fs.writeFileSync(`${modelPath}.tmp`, JSON.stringify(model, null, 2));
      fs.renameSync(`${modelPath}.tmp`, modelPath);
      fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({
        valid: true, status: 'accepted',
        preparationMs, compilationMs: Date.now() - compiledAt, elapsedMs: Date.now() - started,
        attempts: attempt, warnings, assumptions,
      }, null, 2));
      accepted = true;
      emit({ type: 'design', revisionId, valid: true, errors: [], warnings });
      return true;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const runAgent = async (systemPrompt: string, userMessage: string) => {
    let turnText = '', hadError = false;
    const result = await adapter.run({ cwd, message: userMessage, nativeSessionId, model: input.model, systemPrompt }, (event) => {
      if (event.type === 'text') turnText += event.text;
      if (event.type === 'error') hadError = true;
      emit(event);
    }, signal);
    nativeSessionId = result.nativeSessionId ?? nativeSessionId;
    return { result, turnText, hadError };
  };

  try {
    let layoutMessage = message;
    let mergedDone = false;
    let mergedTurnText = '';
    if (!outline.outline && !outline.currentModel) {
      if (signal?.aborted) return { nativeSessionId, failed: true };
      const prompt = buildIntentOnlyPrompt(revisionId, outline);
      const { result, turnText, hadError } = await runAgent(prompt, message);
      const wroteGeometryOutline = quarantineAgentModel();
      if (result.failed || hadError || signal?.aborted) return { nativeSessionId, failed: true };
      if (wroteGeometryOutline) {
        return failNoDeliverable(revisionId, ['请只写 intent.json，不要写 model.json'], requireDesign, emit, nativeSessionId);
      }
      mergedDone = true;
      mergedTurnText = turnText;
      emit({ type: 'progress', message: '已生成设计意图，正在反推外轮廓并编译…' });
    }

    for (let attempt = 0; attempt < LAYOUT_ATTEMPTS; attempt++) {
      if (signal?.aborted) return { nativeSessionId, failed: true };
      if (attempt) emit({ type: 'progress', message: `校验未通过，正在修正（${attempt + 1}/${LAYOUT_ATTEMPTS}）…` });
      if (outline.currentModel && !outline.layout) {
        return failNoDeliverable(revisionId, ['缺少外轮廓，无法编译方案'], requireDesign, emit, nativeSessionId);
      }
      let turnText = mergedTurnText;
      let hadError = false;
      if (!(attempt === 0 && mergedDone)) {
        const systemPrompt = useLayout
          ? buildSpacePrompt(revisionId, outline)
          : outline.outline
            ? buildIntentPrompt(revisionId, outline)
            : buildIntentOnlyPrompt(revisionId, outline);
        const r = await runAgent(systemPrompt, layoutMessage);
        turnText = r.turnText;
        hadError = r.hadError;
        if (r.result.failed || hadError || signal?.aborted) return { nativeSessionId, failed: true };
      }
      const wroteGeometry = quarantineAgentModel();

      const targetPath = useLayout ? layoutPath : intentPath;
      const targetName = useLayout ? 'layout.json' : 'intent.json';
      let dsmlContent: string | undefined;
      if (!fs.existsSync(targetPath)) {
        const extracted = extractDsmlWrite(turnText);
        if (extracted && path.basename(extracted.filePath) === targetName) dsmlContent = extracted.content;
      }
      const ensured = useLayout
        ? ensureAgentLayoutFile(cwd, revisionId, dsmlContent)
        : ensureAgentIntentFile(cwd, revisionId, dsmlContent);
      if (ensured.ok && ensured.recoveredFrom) {
        emit({ type: 'progress', message: `已从误写路径恢复 ${targetName}：${ensured.recoveredFrom} → ${useLayout ? layoutRelativePath(revisionId) : intentRelativePath(revisionId)}` });
      }
      errors = [];
      let output: string | undefined;
      try {
        if (wroteGeometry) errors.push(`请只写 ${targetName}，不要写 model.json`);
        if (!ensured.ok) errors.push(ensured.reason);
        else if (!fs.existsSync(targetPath)) errors.push(`未生成 ${useLayout ? layoutRelativePath(revisionId) : intentRelativePath(revisionId)}`);
        else if ((useLayout ? tryCompileLayoutFile(attempt + 1) : tryCompileIntentFile(attempt + 1))) {
          return { nativeSessionId, failed: false };
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (!errors.length && fs.existsSync(targetPath)) {
        output = fs.readFileSync(targetPath, 'utf8');
      }
      errors = [...new Set(errors)];
      if (attempt < LAYOUT_ATTEMPTS - 1) {
        layoutMessage = useLayout
          ? buildValidationCorrectionMessage(revisionId, errors, output)
          : buildIntentCorrectionMessage(revisionId, errors, output);
      } else {
        emit({ type: 'design', revisionId, valid: false, errors });
      }
    }
    return { nativeSessionId, failed: true };
  } finally {
    if (outline.layout && !accepted) {
      quarantineAgentModel();
      fs.writeFileSync(path.join(folder, 'validation.json'), JSON.stringify({ valid: false, status: 'rejected', errors }, null, 2));
    }
  }
}
