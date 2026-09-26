import { parseSpaceType, validateSpaceTypeDefinition, type SpaceType } from '@sdd/shared';

export function parseSpaceTypesField(raw: unknown): { types: SpaceType[]; errors: string[] } {
  if (raw === undefined || raw === null) return { types: [], errors: [] };
  if (!Array.isArray(raw)) return { types: [], errors: ['spaceTypes 必须是数组'] };

  const types: SpaceType[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const parsed = parseSpaceType(raw[i]);
    const ctx = `spaceTypes[${i}]`;
    if (!parsed) {
      errors.push(`${ctx} 格式无效（需 id、label、color）`);
      continue;
    }
    if (seen.has(parsed.id)) {
      errors.push(`${ctx} id 重复: ${parsed.id}`);
      continue;
    }
    seen.add(parsed.id);
    errors.push(...validateSpaceTypeDefinition(parsed, ctx));
    types.push(parsed);
  }

  return { types, errors };
}
