import { resolveSpaceLabel, type Diagnosis, type OptimizationEvaluation, type OptimizationRun, type SpaceModel } from '@sdd/shared';
import { buildSpatialGraph, unreachableSpaces, type SpatialGraph } from '../geometry/spatialGraph';

function spaceLabel(model: SpaceModel, spaceId: string): string {
  const space = model.spaces.find((s) => s.id === spaceId);
  return space ? resolveSpaceLabel(space, model.spaceTypes) || space.id : spaceId;
}

/** 可修改的门洞，按净宽升序（最窄的优先作为候选）。 */
function candidateDoorIds(graph: SpatialGraph): string[] {
  return graph.edges
    .filter((e) => e.kind === 'door' && !e.locked && e.openingId)
    .sort((a, b) => (a.netWidthM ?? Infinity) - (b.netWidthM ?? Infinity))
    .map((e) => e.openingId!);
}

/**
 * 从基线指标 + 空间关系索引推导诊断。首期用邻接关系缩小候选范围；
 * 观察是数值事实，假设是待验证的原因，操作是建议方向（不直接改写模型）。
 */
export function diagnoseModel(
  model: SpaceModel,
  configs: OptimizationRun['configs'],
  baseline: OptimizationEvaluation,
): Diagnosis[] {
  const graph = buildSpatialGraph(model);
  const diagnoses: Diagnosis[] = [];

  for (const space of baseline.sunlight.spaces) {
    if (space.targetMetRatio == null || space.targetMetRatio >= 1) continue;
    const walls = graph.edges
      .filter((e) => e.kind === 'adjacency' && !e.locked && (e.from === space.spaceId || e.to === space.spaceId))
      .map((e) => e.wallId!)
      .filter(Boolean);
    diagnoses.push({
      issueId: `sunlight-${space.spaceId}`,
      severity: 'warn',
      observation: `${spaceLabel(model, space.spaceId)} 目标日照达标面积比例 ${(space.targetMetRatio * 100).toFixed(0)}%，加权平均 ${space.meanHours.toFixed(2)} h（${space.sensorCount} 测点）`,
      hypothesis: '隔墙或朝向阻挡了部分入射路径',
      operation: '小幅移动已标记可改的隔墙，或交换功能位置',
      verification: '同工况重算该空间及所有受保护空间日照',
      spaceIds: [space.spaceId],
      wallIds: walls.length ? walls : undefined,
    });
  }

  const unreachable = unreachableSpaces(graph);
  if (unreachable.length) {
    diagnoses.push({
      issueId: 'egress-unreachable',
      severity: 'warn',
      observation: `空间不可达：${unreachable.map((id) => spaceLabel(model, id)).join('、')}`,
      hypothesis: '起点到出口的连通路径缺失',
      operation: '新增被允许的内部门洞',
      verification: '先做图与净空检查，再跑同工况疏散',
      spaceIds: unreachable,
    });
  }

  const ped = baseline.pedestrian;
  const doors = candidateDoorIds(graph);
  if (ped.egressTimeSec == null) {
    diagnoses.push({
      issueId: 'egress-timeout',
      severity: 'warn',
      observation: `${ped.totalAgents} 人未能在 ${configs.pedestrian.maxDurationSec}s 内清空`,
      hypothesis: '出口选择或宽度受限',
      operation: '门宽/门位变化，或新增内部门洞',
      verification: '同人数同策略重算轨迹密度与清空时间',
      spaceIds: model.spaces.map((s) => s.id),
      openingIds: doors.length ? doors : undefined,
    });
  } else {
    diagnoses.push({
      issueId: 'egress-time',
      severity: 'info',
      observation: `${ped.totalAgents} 人清空时间 ${ped.egressTimeSec.toFixed(2)}s`,
      hypothesis: '门洞宽度限制或汇流导致排队',
      operation: '门宽/门位变化，或局部通道调整',
      verification: '同人数同策略重算轨迹密度与清空时间',
      spaceIds: model.spaces.map((s) => s.id),
      openingIds: doors.length ? doors : undefined,
    });
  }

  return diagnoses;
}
