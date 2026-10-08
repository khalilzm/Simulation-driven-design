// 人流/疏散工况与结果契约（对齐 sunlight.ts 的契约风格）。

export const PEDESTRIAN_CONFIG_SCHEMA_VERSION = '1';
export const PEDESTRIAN_RESULT_SCHEMA_VERSION = '1';

export type PedestrianScenario = 'egress';
export type PedestrianModel = 'collision-free' | 'gcfm';

export interface PedestrianAgentLoad {
  /** 空间 ID（房间/走廊）；疏散起点在该空间内散布。 */
  spaceId: string;
  /** 该空间的疏散人数（正整数）。 */
  count: number;
}

export interface PedestrianConfig {
  schemaVersion: string;
  scenario: PedestrianScenario;
  model: PedestrianModel;
  /** 仿真步长（秒）。 */
  dt: number;
  /** 疏散时长上限（秒）；到点仍未清空则记为未完成。 */
  maxDurationSec: number;
  /** 随机种子，固定以复现。 */
  seed: number;
  /** 各空间疏散人数。 */
  agents: PedestrianAgentLoad[];
}

export type PedestrianVerificationStatus = 'passed' | 'failed' | 'needs_review';

export interface PedestrianDoorMetrics {
  /** 出口 ID（连接 outside 的门洞）。 */
  exitId: string;
  /** 该出口峰值密度（人/㎡）。 */
  peakDensity: number;
  /** 该出口通过率（人/秒）。 */
  flowRate: number;
}

export interface PedestrianMetrics {
  unit: 'second';
  totalAgents: number;
  /** 最后一名 agent 离开的时间（RSET），未在 maxDurationSec 内清空则为 null。 */
  egressTimeSec: number | null;
  /** 平均疏散时间。 */
  meanEgressTimeSec: number | null;
  peakDoorDensity: PedestrianDoorMetrics[];
  /** 出现拥堵的空间 ID（密度超阈值的房间/走廊）。 */
  bottleneckSpaceIds: string[];
}

export interface PedestrianDensityGrid {
  gridId: string;
  /** 网格顶点 [x, y]（米） */
  vertices: [number, number][];
  /** 三角面顶点索引 */
  faces: number[][];
  /** 每面峰值密度（人/㎡），与 faces 对齐 */
  density: number[];
}

export interface PedestrianTrajectory {
  agentId: number;
  spaceId: string;
  /** 采样时间（秒），与 points 对齐 */
  times: number[];
  points: [number, number][];
}

export interface PedestrianResult {
  schemaVersion: string;
  status: 'completed' | 'failed';
  engineVersion: string;
  scenario: PedestrianScenario;
  metrics: PedestrianMetrics;
  /** 峰值密度网格（热力图） */
  densityGrid?: PedestrianDensityGrid;
  /** 每个 agent 的疏散轨迹（轨迹线 + 动画） */
  trajectories?: PedestrianTrajectory[];
  verification: {
    status: PedestrianVerificationStatus;
    checks: string[];
  };
  error?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function parsePedestrianConfig(
  raw: unknown,
): { ok: true; config: PedestrianConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const o = record(raw);
  if (!o) return { ok: false, errors: ['config 必须是对象'] };

  if (o.schemaVersion !== PEDESTRIAN_CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion 须为 "${PEDESTRIAN_CONFIG_SCHEMA_VERSION}"`);
  }

  if (o.scenario !== 'egress') {
    errors.push('scenario 目前仅支持 "egress"');
  }

  if (o.model !== 'collision-free' && o.model !== 'gcfm') {
    errors.push('model 须为 "collision-free" 或 "gcfm"');
  }

  if (o.dt === undefined) {
    errors.push('dt 缺失');
  } else if (typeof o.dt !== 'number' || !Number.isFinite(o.dt) || o.dt <= 0 || o.dt > 1) {
    errors.push('dt 须为 (0, 1] 的数字');
  }

  if (o.maxDurationSec === undefined) {
    errors.push('maxDurationSec 缺失');
  } else if (typeof o.maxDurationSec !== 'number' || !Number.isFinite(o.maxDurationSec) || o.maxDurationSec <= 0) {
    errors.push('maxDurationSec 须为正数');
  }

  if (o.seed === undefined) {
    errors.push('seed 缺失');
  } else if (typeof o.seed !== 'number' || !Number.isInteger(o.seed)) {
    errors.push('seed 须为整数');
  }

  const agents: PedestrianAgentLoad[] = [];
  if (!Array.isArray(o.agents) || o.agents.length === 0) {
    errors.push('agents 须为非空数组');
  } else {
    const seen = new Set<string>();
    for (const [i, rawAgent] of o.agents.entries()) {
      const item = record(rawAgent);
      const at = `agents[${i}]`;
      if (!item) { errors.push(`${at} 必须是对象`); continue; }
      const spaceId = typeof item.spaceId === 'string' ? item.spaceId.trim() : '';
      if (!spaceId) errors.push(`${at}.spaceId 缺失`);
      else if (seen.has(spaceId)) errors.push(`${at}.spaceId 重复：${spaceId}`);
      else seen.add(spaceId);
      const count = item.count;
      if (count === undefined) errors.push(`${at}.count 缺失`);
      else if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
        errors.push(`${at}.count 须为正整数`);
      }
      if (spaceId && typeof count === 'number' && Number.isInteger(count) && count > 0) {
        agents.push({ spaceId, count });
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    config: {
      schemaVersion: PEDESTRIAN_CONFIG_SCHEMA_VERSION,
      scenario: 'egress',
      model: o.model as PedestrianModel,
      dt: o.dt as number,
      maxDurationSec: o.maxDurationSec as number,
      seed: o.seed as number,
      agents,
    },
  };
}
