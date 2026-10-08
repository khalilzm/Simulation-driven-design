import type { PedestrianResult, PedestrianTrajectory } from '@sdd/shared';
import { trajectoryTimeColor } from './pedestrianColor';

export interface TrajectoryLineGroup {
  positions: number[];
  color: number;
}

const LINE_Z = 0.05;
const BUCKETS = 16;

/** 所有 agent 轨迹按时间颜色分桶，输出扁平 line positions（供 viewer.addLines）。 */
export function trajectoriesToLineGroups(result: PedestrianResult, tMax = pedestrianTMax(result)): TrajectoryLineGroup[] {
  const trajs = result.trajectories ?? [];
  if (!trajs.length || tMax <= 0) return [];
  const buckets: number[][] = Array.from({ length: BUCKETS }, () => []);
  for (const traj of trajs) {
    const pts = traj.points;
    const times = traj.times;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      if (!a || !b) continue;
      const tMid = ((times[k] ?? 0) + (times[k + 1] ?? tMax)) / 2;
      const tNorm = tMid / tMax;
      const bucket = Math.min(BUCKETS - 1, Math.max(0, Math.floor(tNorm * BUCKETS)));
      buckets[bucket].push(a[0], a[1], LINE_Z, b[0], b[1], LINE_Z);
    }
  }
  const groups: TrajectoryLineGroup[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    if (!buckets[b].length) continue;
    const tNorm = (b + 0.5) / BUCKETS;
    groups.push({ positions: buckets[b], color: trajectoryTimeColor(tNorm) });
  }
  return groups;
}

/** 轨迹总时长（所有 agent 最后离开时刻），供回放进度条。 */
export function pedestrianTMax(result: PedestrianResult): number {
  const trajs = result.trajectories ?? [];
  let max = 0;
  for (const tr of trajs) for (const t of tr.times) if (t > max) max = t;
  return max > 0 ? max : (result.metrics.egressTimeSec ?? 0);
}

/** 在时刻 t 对轨迹做线性插值，得到 agent 位置。 */
export function trajectoryPositionAt(traj: PedestrianTrajectory, t: number): [number, number] {
  const times = traj.times;
  const pts = traj.points;
  if (!pts.length) return [0, 0];
  if (t <= times[0] || pts.length === 1) return pts[0];
  for (let k = 0; k < pts.length - 1; k++) {
    if (t <= times[k + 1]) {
      const dt = times[k + 1] - times[k];
      const u = dt > 0 ? (t - times[k]) / dt : 0;
      return [
        pts[k][0] + (pts[k + 1][0] - pts[k][0]) * u,
        pts[k][1] + (pts[k + 1][1] - pts[k][1]) * u,
      ];
    }
  }
  return pts[pts.length - 1];
}
