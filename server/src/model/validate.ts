import {
  buildEffectiveCatalog,
  MODEL_SCHEMA_VERSION,
  polygonGeometryError,
  TYPE_ID_KEY,
  validateBareOpeningDimensions,
  validateBareWallDimensions,
  validateSpaceUsage,
} from '@sdd/shared';
import type { Vec2 } from '@sdd/shared';
import {
  findPolygonEdgeOutside,
  pointInPolygonOrOnEdge,
  polygonContainedInPolygon,
  polygonEdgesContainedInPolygon,
  polylineContainedInPolygon,
} from '../geometry/polygon';
import { wallPolylineLength } from '../design/layoutWalls';
import { parseComponentTypesField } from './parseComponentTypes';
import { parseSpaceTypesField } from './parseSpaceTypes';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** 契约 + 布局几何校验（用于反馈 Agent 自动修正，不修改模型几何）。 */
export function validateModel(input: unknown): ValidationResult {
  if (!input || typeof input !== 'object') {
    return { valid: false, errors: ['模型必须是对象'] };
  }
  const m = input as Record<string, unknown>;
  const errors: string[] = [];

  const meta = m.model as Record<string, unknown> | undefined;
  const unitScale = meta?.units === 'mm' ? 1000 : 1;
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

  const { types: componentTypes, errors: componentTypeErrors } = parseComponentTypesField(m.componentTypes);
  errors.push(...componentTypeErrors);
  const catalog = buildEffectiveCatalog(componentTypes);

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

  const walls = (m.walls as unknown[] | undefined) ?? [];
  const spaces = (m.spaces as unknown[] | undefined) ?? [];
  if (spaces.length > 0 && walls.length === 0) {
    errors.push('存在 spaces 时必须提供 walls（由 Agent 生成墙体中心线）');
  }
  const openings = (m.openings as unknown[] | undefined) ?? [];
  const doors = (m.doors as unknown[] | undefined) ?? [];
  const windows = (m.windows as unknown[] | undefined) ?? [];
  const fixedContext = (m.fixedContext as unknown[] | undefined) ?? [];

  const checkTypeId = (id: string, context: string) => {
    if (!catalog.has(id)) errors.push(`${context} 未知构件类型: ${id}`);
  };

  const wallIds = new Set<string>();
  for (const w of walls) {
    const wall = w as Record<string, unknown>;
    if (typeof wall.id !== 'string') {
      errors.push('wall 缺少 id');
      continue;
    }
    if (wallIds.has(wall.id)) errors.push(`wall id 重复: ${wall.id}`);
    wallIds.add(wall.id);
    const geo = wall.geometry as Record<string, unknown> | undefined;
    const pts = geo?.points as Vec2[] | undefined;
    if (!Array.isArray(pts) || pts.length < 2) {
      errors.push(`wall ${wall.id} 几何点数不足`);
    }
    const wallTypeId = (wall.analysisProperties as Record<string, unknown> | undefined)?.[TYPE_ID_KEY];
    if (typeof wallTypeId === 'string') {
      checkTypeId(wallTypeId, `wall ${wall.id}`);
    } else if (wall.fixed !== true) {
      errors.push(
        ...validateBareWallDimensions(
          Number(wall.thickness) / unitScale,
          Number(wall.height) / unitScale,
          `wall ${wall.id}`,
        ),
      );
    }
    if (floorBoundary && wall.fixed !== true && Array.isArray(pts)) {
      if (!polylineContainedInPolygon(pts, floorBoundary)) {
        errors.push(`wall ${wall.id} 几何超出 floor 外轮廓`);
      }
    }
  }

  if (spaces.length > 0 && spaceTypes.length === 0) {
    errors.push('存在 spaces 时必须声明 spaceTypes（功能区类型表）');
  }

  const spaceIds = new Set<string>();
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
    const spacePts = space.boundary as Vec2[] | undefined;
    if (!Array.isArray(spacePts) || spacePts.length < 3) {
      errors.push(`space ${space.id} 边界点数不足`);
    } else {
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
    }
  }

  const doorOpeningIds = new Set(
    doors
      .map((d) => (d as Record<string, unknown>).openingId)
      .filter((id): id is string => typeof id === 'string'),
  );

  const openingIds = new Set<string>();
  const filledOpeningIds = new Set<string>();
  for (const item of [...doors, ...windows]) {
    const id = (item as Record<string, unknown>).openingId;
    if (typeof id !== 'string') continue;
    if (filledOpeningIds.has(id)) errors.push(`opening ${id} 只能安装一个门或窗`);
    filledOpeningIds.add(id);
  }
  for (const o of openings) {
    const opening = o as Record<string, unknown>;
    if (typeof opening.id !== 'string') {
      errors.push('opening 缺少 id');
      continue;
    }
    if (openingIds.has(opening.id)) errors.push(`opening id 重复: ${opening.id}`);
    openingIds.add(opening.id);
    const hostWallId = opening.hostWallId;
    if (typeof hostWallId !== 'string' || !wallIds.has(hostWallId)) {
      errors.push(`opening ${opening.id} 的宿主墙不存在`);
    }

    const hostWall = walls.find((w) => (w as Record<string, unknown>).id === hostWallId) as
      | Record<string, unknown>
      | undefined;
    const hostPts = (hostWall?.geometry as Record<string, unknown> | undefined)?.points as
      | Vec2[]
      | undefined;
    const wallLen = Array.isArray(hostPts) ? wallPolylineLength(hostPts) : 0;
    const openingWidth = Number(opening.width);
    const openingPos = Number(opening.position);
    if (opening.sillHeight !== undefined) {
      const sill = opening.sillHeight;
      if (typeof sill !== 'number' || !Number.isFinite(sill) || sill < 0) {
        errors.push(`opening ${opening.id} 的 sillHeight 必须是非负数`);
      } else if (hostWall && sill + Number(opening.height) > Number(hostWall.height) + 1e-6) {
        errors.push(`opening ${opening.id} 顶部超过宿主墙高度`);
      }
    }

    const fillRef = typeof opening.fillRef === 'string' ? opening.fillRef : undefined;
    if (fillRef && catalog.has(fillRef)) {
      const cat = catalog.get(fillRef)?.category;
      if (cat !== 'door' && cat !== 'window') {
        errors.push(`opening ${opening.id} 的 fillRef 应为门或窗类型`);
      }
    }

    const isDoor = doorOpeningIds.has(opening.id);
    const isWindow = windows.some((w) => (w as Record<string, unknown>).openingId === opening.id);

    if (hostWall && wallLen > 0 && Number.isFinite(openingWidth) && Number.isFinite(openingPos)) {
      const half = openingWidth / 2;
      const minPos = half;
      const maxPos = wallLen - half;
      if (maxPos < minPos) {
        errors.push(
          `opening ${opening.id} 宽度 ${openingWidth}m 超过墙 ${hostWallId} 长度 ${wallLen.toFixed(2)}m`,
        );
      } else if (openingPos < minPos - 1e-3 || openingPos > maxPos + 1e-3) {
        errors.push(
          `opening ${opening.id} position=${openingPos} 超出墙 ${hostWallId} 有效范围 [${minPos.toFixed(2)}, ${maxPos.toFixed(2)}]（墙长 ${wallLen.toFixed(2)}m）`,
        );
      }
    }

    const door = doors.find((d) => (d as Record<string, unknown>).openingId === opening.id) as
      | Record<string, unknown>
      | undefined;
    const doorTypeId = (door?.analysisProperties as Record<string, unknown> | undefined)?.[TYPE_ID_KEY];
    const hasKnownType =
      (fillRef && catalog.has(fillRef)) ||
      (typeof doorTypeId === 'string' && catalog.has(doorTypeId));

    if (!hasKnownType) {
      if (isDoor) {
        errors.push(
          ...validateBareOpeningDimensions(
            Number(opening.width) / unitScale,
            Number(opening.height) / unitScale,
            'door',
            `opening ${opening.id}`,
          ),
        );
      } else if (isWindow) {
        errors.push(
          ...validateBareOpeningDimensions(
            Number(opening.width) / unitScale,
            Number(opening.height) / unitScale,
            'window',
            `opening ${opening.id}`,
          ),
        );
      }
    }
  }

  for (const d of doors) {
    const door = d as Record<string, unknown>;
    if (typeof door.openingId !== 'string' || !openingIds.has(door.openingId)) {
      errors.push(`door ${typeof door.id === 'string' ? door.id : '?'} 的洞口不存在`);
    }
    const doorTypeId = (door.analysisProperties as Record<string, unknown> | undefined)?.[TYPE_ID_KEY];
    if (typeof doorTypeId === 'string') checkTypeId(doorTypeId, `door ${door.id ?? '?'}`);
  }
  for (const wd of windows) {
    const win = wd as Record<string, unknown>;
    if (typeof win.openingId !== 'string' || !openingIds.has(win.openingId)) {
      errors.push(`window ${typeof win.id === 'string' ? win.id : '?'} 的洞口不存在`);
    }
    const winTypeId = (win.analysisProperties as Record<string, unknown> | undefined)?.[TYPE_ID_KEY];
    if (typeof winTypeId === 'string') checkTypeId(winTypeId, `window ${win.id ?? '?'}`);
  }

  for (const fc of fixedContext) {
    const item = fc as Record<string, unknown>;
    if (typeof item.source === 'string') checkTypeId(item.source, `fixedContext ${item.id ?? '?'}`);
  }

  return { valid: errors.length === 0, errors };
}
