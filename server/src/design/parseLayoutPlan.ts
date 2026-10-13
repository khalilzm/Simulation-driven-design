import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../geometry/polygon';
import type { LayoutBoundarySpec, LayoutPlanV2, LayoutSpaceSpec } from './layoutPlanTypes';
import {
  buildFloorPlanTopology,
  parseNamedVertices,
  resolvePlanRef,
  type FloorPlanTopology,
} from './floorPlanTopology';
import { parseLayoutPlanV2 } from './parseLayoutPlanV2';
import { enrichLayoutPlanWithCatalog } from './layoutCatalogDefaults';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('布局必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function parseLoop(raw: unknown, topo: FloorPlanTopology, field: string): Vec2[] {
  if (!Array.isArray(raw) || raw.length < 3) throw new Error(`${field} 至少需要 3 个引用`);
  const points = raw.map((ref, i) => resolvePlanRef(ref, topo, `${field}[${i}]`));
  return closePolygon(points, 0).slice(0, -1);
}

function parseTopologyBoundaries(raw: unknown, topo: FloorPlanTopology): LayoutBoundarySpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('boundaries 必须是数组');
  return raw.map((rawBoundary) => {
    const item = record(rawBoundary);
    if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('boundary.id 必须是非空字符串');
    if (item.segment !== undefined) throw new Error(`${item.id} 勿使用 segment 坐标；改用 from/to 引用`);
    if (item.kind !== 'wall' && item.kind !== 'open') throw new Error(`${item.id}.kind 只能是 wall 或 open`);
    if (typeof item.leftSpaceId !== 'string' || typeof item.rightSpaceId !== 'string') {
      throw new Error(`${item.id} 必须指定 leftSpaceId 与 rightSpaceId`);
    }
    const from = resolvePlanRef(item.from, topo, `${item.id}.from`);
    const to = resolvePlanRef(item.to, topo, `${item.id}.to`);
    return {
      id: item.id,
      segment: [from, to] as [Vec2, Vec2],
      kind: item.kind as 'wall' | 'open',
      leftSpaceId: item.leftSpaceId,
      rightSpaceId: item.rightSpaceId,
    };
  });
}

function parseTopologySpaces(raw: unknown, topo: FloorPlanTopology): LayoutSpaceSpec[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 64) {
    throw new Error('spaces 需要包含 1～64 个空间');
  }
  return raw.map((rawSpace) => {
    const item = record(rawSpace);
    if (typeof item.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(item.id)) {
      throw new Error('space.id 须为字母开头的英文标识');
    }
    if (item.id === 'outside') throw new Error('outside 为室外边界保留标识，不能作为空间 ID');
    if (typeof item.usage !== 'string' || !item.usage.trim()) throw new Error(`${item.id} 缺少 usage`);
    if (typeof item.enclosed !== 'boolean') throw new Error(`${item.id}.enclosed 必须是布尔值`);
    if (item.boundary !== undefined) {
      throw new Error(`${item.id} 勿提交 boundary 坐标；schemaVersion 3 使用 loop（Vn 与 vertices 引用）`);
    }
    if (!item.loop) throw new Error(`${item.id} 缺少 loop`);
    for (const key of ['targetArea', 'minArea']) {
      if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0)) {
        throw new Error(`${item.id}.${key} 必须是非负平方米数`);
      }
    }
    return {
      id: item.id,
      usage: item.usage.trim(),
      enclosed: item.enclosed,
      boundary: parseLoop(item.loop, topo, `${item.id}.loop`),
      targetArea: item.targetArea as number | undefined,
      minArea: item.minArea as number | undefined,
    };
  });
}

/** 将 schemaVersion 3（拓扑引用）展开为 v2 坐标计划，供既有编译管线使用。 */
export function expandLayoutPlanV3(raw: unknown, floorBoundary: Vec2[], lenient = false): LayoutPlanV2 {
  const root = record(raw);
  if (root.schemaVersion !== 3) throw new Error('expandLayoutPlanV3 需要 schemaVersion: 3');
  for (const field of ['model', 'floor', 'walls', 'allocations', 'splits']) {
    if (field in root) throw new Error(`不要输出 ${field}；只提交 schemaVersion 3 的 spaces、boundaries、vertices 等`);
  }
  const named = parseNamedVertices(root.vertices, buildFloorPlanTopology(floorBoundary));
  const topo = buildFloorPlanTopology(floorBoundary, named);
  const spaces = parseTopologySpaces(root.spaces, topo);
  const boundaries = parseTopologyBoundaries(root.boundaries, topo);
  const v2Shaped = {
    ...root,
    schemaVersion: 2,
    spaces: spaces.map((space) => ({
      ...space,
      boundary: space.boundary,
    })),
    boundaries,
  };
  return parseLayoutPlanV2(v2Shaped, lenient);
}

export function isLayoutPlanV3(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return (raw as Record<string, unknown>).schemaVersion === 3;
}

export function parseLayoutPlan(raw: unknown, floorBoundary: Vec2[], lenient = false): LayoutPlanV2 {
  const plan = isLayoutPlanV3(raw) ? expandLayoutPlanV3(raw, floorBoundary, lenient) : parseLayoutPlanV2(raw, lenient);
  enrichLayoutPlanWithCatalog(plan);
  return plan;
}
