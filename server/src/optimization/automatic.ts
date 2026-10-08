import fs from 'node:fs';
import path from 'node:path';
import { AUTOMATIC_OPTIMIZATION, parseSunlightConfig,
  type AutomaticOptimizationRequest, type OptimizationRequest, type SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../config';
import { ensurePedestrianConfig } from '../pedestrian/ensureConfig';
import { isValidProvider } from '../providers/registry';
import { defaultSunlightTemplatePath } from '../sunlight/ensureConfig';
import { applyDesignPatch, candidatePatches } from './patch';
import { loadOptimizationBaseline, prepareOptimization } from './run';
import { validRevisionId, validSessionId, writeJson } from './store';

export function parseAutomaticOptimizationRequest(raw: unknown): AutomaticOptimizationRequest {
  const r = raw as AutomaticOptimizationRequest;
  if (!r || !validSessionId(r.sessionId) || !validRevisionId(r.revisionId)
    || !isValidProvider(r.provider) || r.provider === 'echo') {
    throw new Error('请选择已解析的方案及可用 Agent');
  }
  return { sessionId: r.sessionId, revisionId: r.revisionId, provider: r.provider };
}

/** A deterministic starting hypothesis, not a claim that the narrowest door is a bottleneck. */
export function selectAutomaticDoor(input: AutomaticOptimizationRequest, model: SpaceModel): OptimizationRequest {
  const doors = model.openings.filter((o) => model.doors.some((d) => d.openingId === o.id))
    .sort((a, b) => a.width - b.width || a.id.localeCompare(b.id));
  for (const door of doors) {
    const request: OptimizationRequest = { ...input, message: AUTOMATIC_OPTIMIZATION.message,
      openingId: door.id, expectedWidthM: door.width,
      maxWidthM: Number((door.width + AUTOMATIC_OPTIMIZATION.maxIncreaseM).toFixed(4)), confirmEditable: true };
    if (candidatePatches(model, request).some((patch) => {
      try { applyDesignPatch(model, patch); return true; } catch { return false; }
    })) return request;
  }
  throw new Error('未找到可增宽或可微调的门洞。本轮需要非固定、非承重直墙上的既有门洞，并留有调整空间；请先修正模型或改用手动设置。');
}

export function prepareAutomaticOptimization(input: AutomaticOptimizationRequest): ReturnType<typeof prepareOptimization> {
  const model = loadOptimizationBaseline(input);
  const request = selectAutomaticDoor(input, model);
  const dir = path.join(workspacesDir, input.sessionId, 'designs', input.revisionId);
  const createdConfigs: ('sunlight' | 'pedestrian')[] = [];
  const sunlightPath = path.join(dir, 'sunlight.json');
  if (!fs.existsSync(sunlightPath)) {
    const template = JSON.parse(fs.readFileSync(defaultSunlightTemplatePath(), 'utf8'));
    // Example room IDs and performance targets are not facts about an uploaded sketch.
    delete template.targets;
    const parsed = parseSunlightConfig(template);
    if (!parsed.ok) throw new Error(parsed.errors.join('；'));
    writeJson(sunlightPath, parsed.config);
    createdConfigs.push('sunlight');
  }
  const pedestrian = ensurePedestrianConfig(path.join(dir, 'pedestrian.json'), model,
    { includeOpenSpaces: !!model.model.sketchId });
  if (pedestrian.errors) throw new Error(pedestrian.errors.join('；'));
  if (pedestrian.created) createdConfigs.push('pedestrian');
  const prepared = prepareOptimization(request);
  prepared.run.automatic = { selection: 'narrowest-feasible', createdConfigs };
  return prepared;
}
