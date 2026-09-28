import { getComponentType, TYPE_ID_KEY, type ComponentType } from '@sdd/shared';
import type { LayoutDoorSpec, LayoutOpeningSpec, LayoutPlanV2, LayoutWindowSpec } from './layoutPlanTypes';

function doorTypeForOpening(plan: LayoutPlanV2, openingId: string): ComponentType | undefined {
  const door = plan.doors?.find((item) => item.openingId === openingId);
  if (door?.typeId) return getComponentType(door.typeId);
  const opening = plan.openings?.find((item) => item.id === openingId);
  if (opening?.typeId) {
    const type = getComponentType(opening.typeId);
    if (type?.category === 'door') return type;
  }
  return undefined;
}

function windowTypeForOpening(plan: LayoutPlanV2, openingId: string): ComponentType | undefined {
  const win = plan.windows?.find((item) => item.openingId === openingId);
  if (win?.typeId) return getComponentType(win.typeId);
  const opening = plan.openings?.find((item) => item.id === openingId);
  if (opening?.typeId) {
    const type = getComponentType(opening.typeId);
    if (type?.category === 'window') return type;
  }
  return undefined;
}

function applyOpeningSize(opening: LayoutOpeningSpec, type: ComponentType): void {
  if (type.category !== 'door' && type.category !== 'window') {
    throw new Error(`opening ${opening.id} 的 typeId ${type.id} 须为门或窗规格`);
  }
  if ((!opening.width || opening.width <= 0) && type.defaults.width !== undefined) opening.width = type.defaults.width;
  if ((!opening.height || opening.height <= 0) && type.defaults.height !== undefined) opening.height = type.defaults.height;
  if (!opening.typeId) opening.typeId = type.id;
}

function applyDoorMotion(door: LayoutDoorSpec, type: ComponentType): void {
  if (type.category !== 'door') throw new Error(`door ${door.id} 的 typeId ${type.id} 不是门规格`);
  if (!door.swing && type.defaults.swing) door.swing = type.defaults.swing;
  if (!door.leafCount && type.defaults.leafCount) door.leafCount = type.defaults.leafCount;
  if (!door.typeId) door.typeId = type.id;
}

/** 用构件目录补全 layout 中省略的洞口尺寸与门扇参数。 */
export function enrichLayoutPlanWithCatalog(plan: LayoutPlanV2): void {
  for (const opening of plan.openings ?? []) {
    if (typeof opening.typeId === 'string') {
      const type = getComponentType(opening.typeId);
      if (!type) throw new Error(`opening ${opening.id} 未知 typeId：${opening.typeId}`);
      applyOpeningSize(opening, type);
    }
    const doorType = doorTypeForOpening(plan, opening.id);
    const windowType = windowTypeForOpening(plan, opening.id);
    if (doorType && windowType) throw new Error(`opening ${opening.id} 不能同时关联门与窗 typeId`);
    if (doorType) applyOpeningSize(opening, doorType);
    else if (windowType) applyOpeningSize(opening, windowType);

    if (!opening.width || opening.width <= 0 || !opening.height || opening.height <= 0) {
      throw new Error(
        `${opening.id} 缺少 width/height；请设置 typeId（如 door-single-900、window-standard-1500）或在 openings 中写正数`,
      );
    }
  }

  for (const door of plan.doors ?? []) {
    if (door.typeId) {
      const type = getComponentType(door.typeId);
      if (!type) throw new Error(`door ${door.id} 未知 typeId：${door.typeId}`);
      applyDoorMotion(door, type);
    } else {
      const type = doorTypeForOpening(plan, door.openingId);
      if (type) applyDoorMotion(door, type);
    }
    if (!door.swing) door.swing = 'left';
    if (!door.leafCount) door.leafCount = 1;
  }

  for (const win of plan.windows ?? []) {
    if (win.typeId) {
      const type = getComponentType(win.typeId);
      if (!type || type.category !== 'window') throw new Error(`window ${win.id} 未知或非法 typeId：${win.typeId}`);
      const opening = plan.openings?.find((item) => item.id === win.openingId);
      if (opening) applyOpeningSize(opening, type);
    }
  }
}

export function catalogTypeIdForModel(typeId: string | undefined): Record<string, unknown> {
  return typeId ? { [TYPE_ID_KEY]: typeId } : {};
}
