import { buildEffectiveCatalog, TYPE_ID_KEY, type SpaceModel, type OptimizationTaskDraft } from '@sdd/shared';

export type WorkbenchStage = 'task' | 'analysis' | 'compare';
export const WORKBENCH_STAGES: { id: WorkbenchStage; label: string }[] = [
  { id: 'task', label: '目标与范围' },
  { id: 'analysis', label: '分析优化' },
  { id: 'compare', label: '比较采用' },
];
export const EMPTY_TASK: OptimizationTaskDraft = { message: '缩短疏散清空时间，保持各空间日照，尽量少增宽。', openingId: '', increaseM: 0.2 };

export function editableDoors(model: SpaceModel) {
  const catalog = buildEffectiveCatalog(model.componentTypes ?? []);
  return model.openings.filter((opening) => model.doors.some((door) => door.openingId === opening.id)).filter((opening) => {
    const wall = model.walls.find((w) => w.id === opening.hostWallId);
    const typeId = wall?.analysisProperties?.[TYPE_ID_KEY];
    return wall && !wall.fixed && wall.role !== 'structural' && wall.role !== 'curtain' && wall.geometry.points.length === 2
      && !(typeof typeId === 'string' && catalog.get(typeId)?.role === 'structural');
  });
}

export function doorEndpoints(model: SpaceModel, opening: SpaceModel['openings'][number]): [number, number][] {
  const points = model.walls.find((wall) => wall.id === opening.hostWallId)?.geometry.points;
  if (!points || points.length !== 2) return [];
  const [a, b] = points, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length <= 0) return [];
  return [-0.5, 0.5].map((side) => {
    const distance = opening.position + side * opening.width;
    return [a[0] + (b[0] - a[0]) * distance / length, a[1] + (b[1] - a[1]) * distance / length];
  });
}
