import { parseComponentType, validateComponentTypeDefinition, type ComponentType } from '@sdd/shared';

export function parseComponentTypesField(raw: unknown): { types: ComponentType[]; errors: string[] } {
  if (raw === undefined || raw === null) return { types: [], errors: [] };
  if (!Array.isArray(raw)) return { types: [], errors: ['componentTypes 必须是数组'] };

  const types: ComponentType[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const parsed = parseComponentType(raw[i]);
    const ctx = `componentTypes[${i}]`;
    if (!parsed) {
      errors.push(`${ctx} 格式无效`);
      continue;
    }
    if (seen.has(parsed.id)) {
      errors.push(`${ctx} id 重复: ${parsed.id}`);
      continue;
    }
    seen.add(parsed.id);
    errors.push(...validateComponentTypeDefinition(parsed, ctx));
    types.push(parsed);
  }

  return { types, errors };
}
