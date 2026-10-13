import type { CapabilityId } from './contracts';

export interface IdentityResource { id: string; version: string; contentHash: string }
export interface ResultIdentityContext {
  scope: { sessionId: string; modelRevisionId: string };
  baseMap: IdentityResource | null;
  requirements: IdentityResource | null;
  scenario: { id: string; version: string };
  rules: Record<string, string>;
  plan: { schemaVersion: string; version: string };
  modules: { id: string; version: string; capability: CapabilityId; configHash: string; engineVersion: string }[];
}

/** Cache identity includes candidate geometry; comparison identity deliberately excludes it. */
export interface ResultIdentity {
  schemaVersion: '1';
  context: ResultIdentityContext;
  modelHash: string;
  inputHash: string;
  comparisonHash: string;
}
