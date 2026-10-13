import { createHash } from 'node:crypto';
import { parseScenarioWorkspaceInputs, workspaceAnalysisPlan, type ScenarioWorkspaceInputs,
  type AnalysisPlan, type ResultIdentity, type ResultIdentityContext, type SpaceModel } from '@sdd/shared';

/** Stable object keys, preserved array order and explicit rejection of non-finite scientific inputs. */
export function canonicalHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'number' && !Number.isFinite(input)) throw new Error('身份输入包含非有限数值');
    if (['bigint','function','symbol'].includes(typeof input)) throw new Error('身份输入必须为 JSON 数据');
    if (Array.isArray(input)) return input.map(item => item === undefined ? null : normalize(item));
    if (input && typeof input === 'object') {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('身份输入必须为 JSON 对象');
      return Object.fromEntries(Object.keys(input).sort()
      .filter(key => (input as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, normalize((input as Record<string, unknown>)[key])]));
    }
    return input;
  };
  const json = JSON.stringify(normalize(value));
  if (json === undefined) throw new Error('身份输入不可序列化');
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

/** Keep persisted file-integrity hashes readable; never use this as a new result cache identity. */
export const legacyStorageHash = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Graph layout is presentation; the remaining typed demand fields define the actual requirement. */
export function semanticRequirements<T extends { rooms: unknown[]; relations: unknown[] }>(brief: T): unknown {
  const omit = (raw: unknown, key: string) => {
    const object = { ...(raw as Record<string, unknown>) }; delete object[key]; return object;
  };
  return { ...brief, rooms: brief.rooms.map(room => omit(room, 'position')),
    relations: brief.relations.map(relation => omit(relation, 'diagramHandles')) };
}

export function semanticModelHash(model: SpaceModel): string {
  const { revisionId: _revision, parentRevisionId: _parent, ...meta } = model.model;
  return canonicalHash({ ...model, model: meta });
}

function comparisonContext(context: ResultIdentityContext) {
  return { ...context, scope: { sessionId: context.scope.sessionId } };
}
export function createResultIdentity(model: SpaceModel, context: ResultIdentityContext): ResultIdentity {
  const frozen = structuredClone(context), modelHash = semanticModelHash(model);
  return { schemaVersion: '1', context: frozen, modelHash,
    inputHash: canonicalHash({ identityVersion: '1', context: frozen, modelHash }),
    comparisonHash: canonicalHash({ identityVersion: '1', context: comparisonContext(frozen) }) };
}
export function validResultIdentity(identity?: ResultIdentity): boolean {
  try {
    return !!identity && identity.schemaVersion === '1'
      && identity.inputHash === canonicalHash({ identityVersion: '1', context: identity.context, modelHash: identity.modelHash })
      && identity.comparisonHash === canonicalHash({ identityVersion: '1', context: comparisonContext(identity.context) });
  } catch { return false; }
}
export function sameCachedResult(actual: ResultIdentity | undefined, expected: ResultIdentity): boolean {
  return validResultIdentity(actual) && actual!.inputHash === expected.inputHash;
}
export function comparableIdentities(a?: ResultIdentity, b?: ResultIdentity): boolean {
  return validResultIdentity(a) && validResultIdentity(b) && a!.comparisonHash === b!.comparisonHash;
}
export function identityEngineVersionsMatch(identity: ResultIdentity | undefined, reported: Record<string, string>): boolean {
  return validResultIdentity(identity) && Object.entries(reported).every(([capability, version]) => {
    const modules = identity!.context.modules.filter(module => module.capability === capability);
    return modules.length === 1 && modules[0].engineVersion === version;
  });
}

export function identityModules(plan: AnalysisPlan, engines: Record<string, string>): ResultIdentityContext['modules'] {
  return plan.steps.map(step => {
    const engineVersion = engines[step.capability];
    if (!engineVersion) throw new Error(`缺少 ${step.capability} 引擎版本`);
    return { id: step.moduleId ?? step.capability, version: step.moduleVersion ?? '1', capability: step.capability,
      configHash: canonicalHash(step.config), engineVersion };
  });
}

/** Generic multi-module workspaces supply hashes from their validated map/graph resource adapters. */
export function workspaceResultIdentity(model: SpaceModel, sessionId: string, input: ScenarioWorkspaceInputs,
  resourceHashes: { baseMap: string; spaceGraph: string }, engines: Record<string, string>, rules: Record<string, string>) {
  const workspace = parseScenarioWorkspaceInputs(input), plan = workspaceAnalysisPlan(workspace);
  return createResultIdentity(model, {
    scope: { sessionId, modelRevisionId: model.model.revisionId },
    baseMap: { id: workspace.baseMap.id, version: workspace.baseMap.version, contentHash: resourceHashes.baseMap },
    requirements: { id: workspace.spaceGraph.id, version: workspace.spaceGraph.version, contentHash: resourceHashes.spaceGraph },
    scenario: workspace.scenario, rules, plan: { schemaVersion: plan.schemaVersion, version: '1' },
    modules: identityModules(plan, engines),
  });
}
