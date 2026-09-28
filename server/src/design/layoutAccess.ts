import type { SpaceModel } from '@sdd/shared';
import { pointAlongWallPolyline } from '../model/geometry';
import type { LayoutBoundarySpec, LayoutDoorSpec } from './layoutPlanTypes';
import { segmentCoveredBy } from './layoutWalls';
import { sharedSegments } from './regionGeometry';

/** 开放边界、落地门洞构成通行图；窗洞不构成通路。 */
export function validateLayoutAccess(model: SpaceModel, boundaries: LayoutBoundarySpec[], doorSpecs: LayoutDoorSpec[]): string[] {
  const graph = new Map<string, Set<string>>([...model.spaces.map((space) => space.id), 'outside']
    .map((id) => [id, new Set<string>()]));
  const connect = (a: string, b: string) => { graph.get(a)!.add(b); graph.get(b)!.add(a); };
  for (const boundary of boundaries) {
    if (boundary.kind === 'open') connect(boundary.leftSpaceId, boundary.rightSpaceId);
  }
  const windowOpenings = new Set(model.windows.map((window) => window.openingId));
  const scale = model.model.units === 'mm' ? 1000 : 1;
  for (const opening of model.openings) {
    if (windowOpenings.has(opening.id)) continue;
    const door = model.doors.find((item) => item.openingId === opening.id);
    if ((opening.sillHeight ?? 0) > 1e-6 * scale) {
      if (door) throw new Error(`door ${door.id} 的洞口必须落地（sillHeight 为 0）`);
      continue;
    }
    // 高窗、低矮通风口不能充当人员通路。
    if (!door && opening.height < 1.8 * scale) continue;
    const wall = model.walls.find((item) => item.id === opening.hostWallId);
    if (!wall) throw new Error(`opening ${opening.id} 的宿主墙不存在`);
    const a = pointAlongWallPolyline(wall.geometry.points, opening.position - opening.width / 2);
    const b = pointAlongWallPolyline(wall.geometry.points, opening.position + opening.width / 2);
    if (!a || !b) throw new Error(`opening ${opening.id} 的宿主墙几何无效`);
    const sides = model.spaces.filter((space) => segmentCoveredBy(a, b, sharedSegments(space.boundary, [a, b])))
      .map((space) => space.id);
    if (segmentCoveredBy(a, b, sharedSegments(model.floor.boundary, [a, b]))) sides.push('outside');
    if (sides.length !== 2) throw new Error(`opening ${opening.id} 未完整位于两个空间（或空间与 outside）的边界上`);
    const expected = doorSpecs.find((spec) => spec.id === door?.id)?.connects;
    if (expected && (new Set(expected).size !== 2 || !sides.every((id) => expected.includes(id)))) {
      throw new Error(`door ${door!.id} 的 connects 与洞口实际两侧空间不一致`);
    }
    connect(sides[0], sides[1]);
  }
  const hasEntry = graph.get('outside')!.size > 0;
  const roots = hasEntry ? ['outside'] : model.spaces.filter((space) => !space.enclosed).map((space) => space.id);
  const reached = new Set(roots), queue = [...roots];
  for (let i = 0; i < queue.length; i++) for (const next of graph.get(queue[i])!) {
    if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  const warnings: string[] = [];
  for (const space of model.spaces) {
    if ((hasEntry || space.enclosed) && !reached.has(space.id)) {
      warnings.push(`空间 ${space.id} 不可达：请用门洞或开放边界连接${hasEntry ? '入口' : '开放交通区或室外入口'}`);
    }
  }
  return hasEntry ? warnings : [...warnings, '尚未确定室外入口；当前仅检查封闭空间到开放区的通行关系'];
}
