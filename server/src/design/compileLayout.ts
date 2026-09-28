import type { LayoutContext } from './layoutContext';
import { compileLayoutPlan } from './compileLayoutPlan';

function rejectLegacyLayout(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const root = raw as Record<string, unknown>;
  if ('allocations' in root || 'splits' in root) {
    throw new Error('layout.json 不再支持 allocations/regionIds/splits；请改用 schemaVersion 3（推荐）或 2');
  }
  const version = root.schemaVersion;
  if (version !== 2 && version !== 3) {
    throw new Error('layout.json 须包含 schemaVersion: 3（拓扑引用，推荐）或 2');
  }
}

export function compileLayout(
  raw: unknown,
  ctx: LayoutContext,
  revisionId: string,
  requireFullCoverage = false,
): { model: import('@sdd/shared').SpaceModel; warnings: string[]; assumptions: string[] } {
  rejectLegacyLayout(raw);
  return compileLayoutPlan(raw, ctx, revisionId, requireFullCoverage);
}
