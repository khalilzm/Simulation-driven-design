import type { SpaceModel, SpaceType } from '@sdd/shared';

const PALETTE = [
  '#FFE4A8', '#A8C8F0', '#FFB878', '#98D4B8', '#88C8E8', '#FFD0A0', '#C8B8E8',
];

function slugTypeId(seed: string): string {
  const s = seed.trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '');
  if (!s) return 'space';
  return /^[a-z]/.test(s) ? s : `t-${s}`;
}

function colorForId(id: string, index: number): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[(h + index) % PALETTE.length];
}

/** 缺失 spaceTypes 时从 spaces 的 typeId / usage 自动推断，避免校验卡住 finalize */
export function inferSpaceTypes(model: SpaceModel): void {
  const map = new Map<string, SpaceType>();
  for (const t of model.spaceTypes ?? []) map.set(t.id, t);

  let added = 0;
  for (const space of model.spaces) {
    const typeId = (typeof space.typeId === 'string' && space.typeId.trim())
      ? space.typeId.trim()
      : slugTypeId(space.usage || space.id);
    space.typeId = typeId;

    if (!map.has(typeId)) {
      map.set(typeId, {
        id: typeId,
        label: space.usage?.trim() || typeId,
        color: colorForId(typeId, added++),
      });
    }
  }

  if (map.size > 0) model.spaceTypes = [...map.values()];
}
