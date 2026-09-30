import {
  buildEffectiveCatalog,
  CUSTOM_COMPONENT_KEY,
  getComponentType,
  TYPE_ID_KEY,
  type ComponentCategory,
  type ComponentType,
  type EffectiveCatalog,
} from '@sdd/shared';
import type { SpaceModel } from '@sdd/shared';

function typeIdFrom(props: Record<string, unknown> | undefined): string | undefined {
  const id = props?.[TYPE_ID_KEY];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function catalogFor(model: SpaceModel): EffectiveCatalog {
  return buildEffectiveCatalog(model.componentTypes ?? []);
}

function resolveOpeningTypeId(
  catalog: EffectiveCatalog,
  fillRef: string | undefined,
  doorTypeId: string | undefined,
  windowTypeId: string | undefined,
): string | undefined {
  if (fillRef && catalog.has(fillRef)) return fillRef;
  return doorTypeId ?? windowTypeId;
}

function applyDoorDefaults(door: SpaceModel['doors'][number], type: ComponentType): void {
  door.analysisProperties = { ...door.analysisProperties, [TYPE_ID_KEY]: type.id };
  delete door.analysisProperties[CUSTOM_COMPONENT_KEY];
  if (type.defaults.leafCount !== undefined) door.leafCount = type.defaults.leafCount;
  if (type.defaults.swing !== undefined) door.swing = type.defaults.swing;
}

function applyWindowDefaults(win: SpaceModel['windows'][number], type: ComponentType): void {
  win.analysisProperties = { ...win.analysisProperties, [TYPE_ID_KEY]: type.id };
  delete win.analysisProperties[CUSTOM_COMPONENT_KEY];
}

function applyOpeningSize(opening: SpaceModel['openings'][number], type: ComponentType): void {
  if (type.defaults.width !== undefined && (!opening.width || opening.width <= 0)) {
    opening.width = type.defaults.width;
  }
  if (type.defaults.height !== undefined && (!opening.height || opening.height <= 0)) {
    opening.height = type.defaults.height;
  }
  opening.fillRef = type.id;
}

function markBareCustom(props: Record<string, unknown>): Record<string, unknown> {
  return { ...props, [CUSTOM_COMPONENT_KEY]: true };
}

/** 按构件目录补齐默认尺寸，并规范 typeId 引用 */
export function resolveComponentDefaults(model: SpaceModel): SpaceModel {
  const catalog = catalogFor(model);
  const doorByOpening = new Map(model.doors.map((d) => [d.openingId, d]));
  const windowByOpening = new Map(model.windows.map((w) => [w.openingId, w]));

  for (const opening of model.openings) {
    const door = doorByOpening.get(opening.id);
    const win = windowByOpening.get(opening.id);
    const doorTypeId = typeIdFrom(door?.analysisProperties);
    const windowTypeId = typeIdFrom(win?.analysisProperties);
    const typeId = resolveOpeningTypeId(catalog, opening.fillRef, doorTypeId, windowTypeId);
    if (!typeId) continue;

    const type = catalog.get(typeId);
    if (!type) continue;

    if (type.category === 'door' && door) {
      applyDoorDefaults(door, type);
      applyOpeningSize(opening, type);
    } else if (type.category === 'window' && win) {
      applyWindowDefaults(win, type);
      applyOpeningSize(opening, type);
    } else if (type.category === 'door' || type.category === 'window') {
      applyOpeningSize(opening, type);
    }
  }

  for (const wall of model.walls) {
    if (wall.fixed) continue;
    const typeId = typeIdFrom(wall.analysisProperties);
    if (!typeId) {
      if (wall.thickness > 0 && wall.height > 0) {
        wall.analysisProperties = markBareCustom(wall.analysisProperties ?? {});
      }
      continue;
    }
    const type = catalog.get(typeId);
    if (!type || type.category !== 'wall') continue;
    if (type.defaults.thickness !== undefined) wall.thickness = type.defaults.thickness;
    if (type.defaults.height !== undefined) wall.height = type.defaults.height;
    if (type.role) {
      wall.role = type.role;
      // 承重墙默认固定：物理承重，优化/迭代不应移动或删除。
      if (type.role === 'structural') wall.fixed = true;
    }
    wall.analysisProperties = { ...wall.analysisProperties, [TYPE_ID_KEY]: type.id };
    delete wall.analysisProperties[CUSTOM_COMPONENT_KEY];
  }

  for (const item of model.fixedContext) {
    const typeId = item.source ?? typeIdFrom({ [TYPE_ID_KEY]: item.kind });
    if (!typeId) continue;
    const type = catalog.get(typeId);
    if (!type) continue;
    const expectedKind: ComponentCategory | undefined =
      type.category === 'elevator' || type.category === 'stair' ? type.category : undefined;
    if (expectedKind) item.kind = expectedKind;
    item.source = type.id;
  }

  return model;
}

export { getComponentType, buildEffectiveCatalog };
