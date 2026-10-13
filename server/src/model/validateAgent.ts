import {
  MODEL_SCHEMA_VERSION,
  polygonGeometryError,
  validateSpaceUsage,
} from '@sdd/shared';
import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../geometry/polygon';
import {
  findPolygonEdgeOutside,
  pointInPolygonOrOnEdge,
  polygonContainedInPolygon,
  polygonEdgesContainedInPolygon,
  polygonsHaveAreaOverlap,
} from '../geometry/polygon';
import { parseSpaceTypesField } from './parseSpaceTypes';
import type { ValidationResult } from './validate';

/** 校验 Agent 输出的 spaces 与 walls 是否在平面轮廓内 */
export function validateAgentModel(input: unknown, allowEmptySpaces = false): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['模型必须是对象'] };
  }
  const m = input as Record<string, unknown>;
  const errors: string[] = [];

  const meta = m.model as Record<string, unknown> | undefined;
  if (!meta) {
    errors.push('缺少 model 元信息');
  } else {
    if (meta.schemaVersion !== MODEL_SCHEMA_VERSION) {
      errors.push(`schemaVersion 必须为 "${MODEL_SCHEMA_VERSION}"`);
    }
    if (typeof meta.revisionId !== 'string' || !/^rev-\d+$/.test(meta.revisionId)) {
      errors.push('revisionId 格式应为 rev-XXXX');
    }
    if (meta.units !== 'm' && meta.units !== 'mm') {
      errors.push('units 必须是 m 或 mm');
    }
  }

  const { types: spaceTypes, errors: spaceTypeErrors } = parseSpaceTypesField(m.spaceTypes);
  errors.push(...spaceTypeErrors);
  const spaceTypeIds = new Set(spaceTypes.map((t) => t.id));

  const floor = m.floor as Record<string, unknown> | undefined;
  let floorBoundary: Vec2[] | null = null;
  if (!floor) {
    errors.push('缺少 floor');
  } else if (!Array.isArray(floor.boundary) || (floor.boundary as Vec2[]).length < 3) {
    errors.push('floor.boundary 点数不足');
  } else {
    const geometryError = polygonGeometryError(floor.boundary);
    if (geometryError) errors.push(`floor.boundary ${geometryError}`);
    else floorBoundary = floor.boundary as Vec2[];
  }

  const spaces = (m.spaces as unknown[] | undefined) ?? [];
  const walls = (m.walls as unknown[] | undefined) ?? [];
  if (spaces.length === 0 && !allowEmptySpaces) errors.push('至少需要一个 space');
  if (spaces.length > 0 && walls.length === 0) {
    errors.push('存在 spaces 时必须提供 walls（由 Agent 生成墙体中心线）');
  }
  if (spaces.length > 0 && spaceTypes.length === 0) {
    errors.push('存在 spaces 时必须声明 spaceTypes（功能区类型表）');
  }

  const spaceIds = new Set<string>();
  const spaceBoundaries: { id: string; boundary: Vec2[] }[] = [];
  for (const s of spaces) {
    const space = s as Record<string, unknown>;
    if (typeof space.id !== 'string') {
      errors.push('space 缺少 id');
      continue;
    }
    if (spaceIds.has(space.id)) errors.push(`space id 重复: ${space.id}`);
    spaceIds.add(space.id);
    const typeId = space.typeId;
    if (typeof typeId !== 'string' || !typeId.trim()) {
      errors.push(`space ${space.id} 缺少 typeId（须引用 spaceTypes.id）`);
    } else if (spaceTypeIds.size > 0 && !spaceTypeIds.has(typeId)) {
      errors.push(`space ${space.id} 的 typeId「${typeId}」未在 spaceTypes 中定义`);
    }
    errors.push(...validateSpaceUsage(space.usage, space.id));
    const spacePtsRaw = space.boundary as Vec2[] | undefined;
    if (!Array.isArray(spacePtsRaw) || spacePtsRaw.length < 3) {
      errors.push(`space ${space.id} 边界点数不足`);
    } else {
      const spacePts = closePolygon(spacePtsRaw);
      const geometryError = polygonGeometryError(spacePts);
      if (geometryError) {
        errors.push(`space ${space.id} ${geometryError}`);
      } else if (floorBoundary) {
        if (!polygonContainedInPolygon(spacePts, floorBoundary)) {
          const bad = spacePts.find((p) => !pointInPolygonOrOnEdge(p, floorBoundary));
          const coord = bad ? `[${bad[0]}, ${bad[1]}]` : '';
          errors.push(`space ${space.id} 边界顶点超出 floor 外轮廓${coord ? `（如 ${coord}）` : ''}`);
        } else if (!polygonEdgesContainedInPolygon(spacePts, floorBoundary)) {
          const edge = findPolygonEdgeOutside(spacePts, floorBoundary);
          const detail = edge
            ? `（边 ${JSON.stringify(edge.from)}→${JSON.stringify(edge.to)} 上的点 ${JSON.stringify(edge.point)} 在外）`
            : '';
          errors.push(`space ${space.id} 边界边线穿出 floor 外轮廓${detail}`);
        }
      }
      if (Array.isArray(spacePts) && spacePts.length >= 3) {
        spaceBoundaries.push({ id: space.id as string, boundary: spacePts });
      }
    }
  }

  for (let i = 0; i < spaceBoundaries.length; i++) {
    for (let j = i + 1; j < spaceBoundaries.length; j++) {
      const a = spaceBoundaries[i];
      const b = spaceBoundaries[j];
      if (polygonsHaveAreaOverlap(a.boundary, b.boundary)) {
        errors.push(`space ${a.id} 与 space ${b.id} 区域重叠，请调整边界；复杂剩余区域可拆分为多个不重叠的同类 space`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
