import fs from 'node:fs';
import path from 'node:path';
import type { DesignPatch, MoveWindowPatch, OptimizationRun, ResizeWindowPatch, SpaceModel } from '@sdd/shared';
import { config, repoRoot } from '../config';
import type { ProviderAdapter } from '../providers/types';
import { hashValue, optimizationDir, writeJson } from './store';

export interface PatchOperation {
  type: 'resizeOpening' | 'moveOpening' | 'offsetPartition' | 'swapProgram' | 'resizeWindow' | 'moveWindow';
  widthM?: number;
  position?: number;
  wallId?: string;
  offsetM?: number;
  spaceA?: string;
  spaceB?: string;
  openingId?: string;
}

export interface PatchProposalCandidate {
  /** 一个候选 = 1～4 个操作的组合（例如：增宽门 + 偏移隔墙 + 增宽外窗）。 */
  operations: PatchOperation[];
  rationale: string;
}

export interface PatchProposal {
  schemaVersion: 1;
  status: 'ready' | 'needs_input';
  summary: string;
  candidates: PatchProposalCandidate[];
}

export interface PartitionCandidate {
  wallId: string;
  offsetM: number;
}

export interface SwapCandidate {
  spaceA: string;
  spaceB: string;
}

const OP_KEYS = ['type', 'widthM', 'position', 'wallId', 'offsetM', 'spaceA', 'spaceB', 'openingId'];

export function parseProposal(raw: unknown, allowedWidths: number[], allowedPositions: number[],
  allowedPartitions: PartitionCandidate[], allowedSwaps: SwapCandidate[],
  allowedWindowResizes: ResizeWindowPatch[], allowedWindowMoves: MoveWindowPatch[]): PatchProposal {
  const p = raw as PatchProposal;
  const keys = (o: object, allowedKeys: string[]) => Object.keys(o).every((k) => allowedKeys.includes(k));
  if (!p || typeof p !== 'object' || Array.isArray(p) || !keys(p, ['schemaVersion', 'status', 'summary', 'candidates'])
    || p.schemaVersion !== 1 || !['ready', 'needs_input'].includes(p.status)
    || typeof p.summary !== 'string' || !p.summary.trim() || p.summary.length > 2000 || !Array.isArray(p.candidates)
    || (p.status === 'needs_input' ? p.candidates.length !== 0 : p.candidates.length < 1 || p.candidates.length > 4)) {
    throw new Error('proposal.json 格式无效，请按指定结构输出');
  }
  const seen = new Set<string>();
  for (const c of p.candidates) {
    if (!c || typeof c !== 'object' || !keys(c, ['operations', 'rationale'])
      || !Array.isArray(c.operations) || c.operations.length < 1 || c.operations.length > 8
      || typeof c.rationale !== 'string' || !c.rationale.trim() || c.rationale.length > 1000) {
      throw new Error('候选必须包含至少 1 个操作，且包含简短理由');
    }
    for (const op of c.operations) {
      if (!op || typeof op !== 'object' || !keys(op, OP_KEYS)
        || !['resizeOpening', 'moveOpening', 'offsetPartition', 'swapProgram', 'resizeWindow', 'moveWindow'].includes(op.type)) {
        throw new Error('操作类型无效');
      }
      let key: string;
      if (op.type === 'resizeOpening') {
        if (typeof op.widthM !== 'number' || !allowedWidths.includes(op.widthM)) throw new Error('候选必须使用允许的宽度');
        key = `resizeOpening:${op.widthM}`;
      } else if (op.type === 'moveOpening') {
        if (typeof op.position !== 'number' || !allowedPositions.includes(op.position)) throw new Error('候选必须使用允许的门位');
        key = `moveOpening:${op.position}`;
      } else if (op.type === 'offsetPartition') {
        if (typeof op.wallId !== 'string' || typeof op.offsetM !== 'number'
          || !allowedPartitions.some((a) => a.wallId === op.wallId && a.offsetM === op.offsetM)) throw new Error('候选必须使用允许的隔墙与偏移');
        key = `offsetPartition:${op.wallId}:${op.offsetM}`;
      } else if (op.type === 'swapProgram') {
        if (typeof op.spaceA !== 'string' || typeof op.spaceB !== 'string'
          || !allowedSwaps.some((s) => s.spaceA === op.spaceA && s.spaceB === op.spaceB)) throw new Error('候选必须使用允许的功能交换对');
        key = `swapProgram:${op.spaceA}:${op.spaceB}`;
      } else if (op.type === 'resizeWindow') {
        if (typeof op.openingId !== 'string' || typeof op.widthM !== 'number'
          || !allowedWindowResizes.some((r) => r.openingId === op.openingId && r.widthM === op.widthM)) throw new Error('候选必须使用允许的外窗宽度');
        key = `resizeWindow:${op.openingId}:${op.widthM}`;
      } else {
        if (typeof op.openingId !== 'string' || typeof op.position !== 'number'
          || !allowedWindowMoves.some((m) => m.openingId === op.openingId && m.position === op.position)) throw new Error('候选必须使用允许的外窗位');
        key = `moveWindow:${op.openingId}:${op.position}`;
      }
      if (seen.has(key)) throw new Error('操作不得重复');
      seen.add(key);
    }
  }
  return p;
}

export async function planPatches(run: OptimizationRun, model: SpaceModel, allowedWidths: number[], allowedPositions: number[],
  allowedPartitions: PartitionCandidate[], allowedSwaps: SwapCandidate[],
  allowedWindowResizes: ResizeWindowPatch[], allowedWindowMoves: MoveWindowPatch[],
  adapter: ProviderAdapter, signal: AbortSignal, progress: (message: string) => void):
  Promise<{ status: 'ready' | 'needs_input'; summary: string; candidates: { patch: DesignPatch; lineage: DesignPatch[]; rationale: string }[] }> {
  const opening = model.openings.find((o) => o.id === run.request.openingId);
  const currentPosition = opening?.position ?? 0;
  const skill = fs.readFileSync(path.join(repoRoot, 'agent/skills/door-width-optimization/SKILL.md'), 'utf8');
  const prompt = fs.readFileSync(path.join(repoRoot, 'agent/prompts/door-width-optimization.md'), 'utf8');
  const cwd = path.join(optimizationDir(run.sessionId, run.id), 'agent');
  const context = { userMessage: run.request.message, openingId: run.request.openingId,
    currentWidthM: run.request.expectedWidthM, maxWidthM: run.request.maxWidthM, currentPositionM: currentPosition,
    allowedWidths, allowedPositions, allowedPartitions, allowedSwaps,
    allowedWindowResizes, allowedWindowMoves, policy: run.policy,
    spaces: model.spaces.map(({ id, usage }) => ({ id, usage })), baseline: run.baseline };
  writeJson(path.join(cwd, 'input.json'), context);
  fs.writeFileSync(path.join(cwd, 'prompt.md'), `${skill}\n\n${prompt}`);
  run.planner = { promptHash: hashValue({ skill, prompt }), attempts: 0 };
  let correction = '', nativeSessionId: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    signal.throwIfAborted();
    run.planner.attempts = attempt;
    let providerError: string | undefined;
    const result = await adapter.run({ cwd, systemPrompt: `${skill}\n\n${prompt}`,
      message: `${JSON.stringify(context)}${correction}`, nativeSessionId, model: config.model || undefined },
    (event) => {
      if (event.type === 'progress') progress(event.message);
      if (event.type === 'error') providerError = event.message;
    }, signal);
    signal.throwIfAborted();
    if (result.failed || providerError) throw new Error(providerError ?? 'Agent 调用失败');
    nativeSessionId = result.nativeSessionId;
    try {
      const proposal = parseProposal(JSON.parse(fs.readFileSync(path.join(cwd, 'proposal.json'), 'utf8')),
        allowedWidths, allowedPositions, allowedPartitions, allowedSwaps, allowedWindowResizes, allowedWindowMoves);
      const candidates = proposal.candidates.map((c): { patch: DesignPatch; lineage: DesignPatch[]; rationale: string } => {
        const lineage = c.operations.map((op): DesignPatch => {
          if (op.type === 'resizeOpening') {
            return { type: 'resizeOpening', openingId: run.request.openingId, expectedWidthM: run.request.expectedWidthM, widthM: op.widthM!, maxWidthM: run.request.maxWidthM };
          }
          if (op.type === 'moveOpening') {
            return { type: 'moveOpening', openingId: run.request.openingId, expectedPosition: currentPosition, position: op.position! };
          }
          if (op.type === 'offsetPartition') {
            const wall = model.walls.find((w) => w.id === op.wallId)!;
            return { type: 'offsetPartition', wallId: op.wallId!, expectedFrom: wall.geometry.points[0], expectedTo: wall.geometry.points[wall.geometry.points.length - 1], offsetM: op.offsetM! };
          }
          if (op.type === 'swapProgram') {
            return { type: 'swapProgram', spaceA: op.spaceA!, spaceB: op.spaceB! };
          }
          if (op.type === 'resizeWindow') {
            return allowedWindowResizes.find((r) => r.openingId === op.openingId && r.widthM === op.widthM)!;
          }
          return allowedWindowMoves.find((m) => m.openingId === op.openingId && m.position === op.position)!;
        });
        return { patch: lineage[0], lineage, rationale: c.rationale };
      });
      return { status: proposal.status, summary: proposal.summary, candidates };
    } catch (error) {
      if (attempt === 2) throw error;
      correction = `\n上次输出未通过校验：${error instanceof Error ? error.message : String(error)}。请仅修正 proposal.json。`;
      progress('候选提议格式未通过校验，修正一次…');
    }
  }
  throw new Error('未生成候选提议');
}
