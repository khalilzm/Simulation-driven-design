import fs from 'node:fs';
import path from 'node:path';
import { parseSunlightConfig } from '@sdd/shared';
import { repoRoot } from '../config';

const DEFAULT_TEMPLATE = path.join(repoRoot, 'examples', 'scenarios', 'sunlight-rev-0001.json');

export function defaultSunlightTemplatePath(): string {
  return DEFAULT_TEMPLATE;
}

/** 若 revision 目录无 sunlight.json，从仓库示例复制一份（仅首次创建）。 */
export function ensureSunlightConfig(configPath: string): { created: boolean; errors?: string[] } {
  if (fs.existsSync(configPath)) {
    return { created: false };
  }
  if (!fs.existsSync(DEFAULT_TEMPLATE)) {
    return {
      created: false,
      errors: [`缺少默认模板 ${DEFAULT_TEMPLATE}`],
    };
  }
  const raw = JSON.parse(fs.readFileSync(DEFAULT_TEMPLATE, 'utf8'));
  const parsed = parseSunlightConfig(raw);
  if (!parsed.ok) {
    return { created: false, errors: parsed.errors };
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`);
  fs.renameSync(tmp, configPath);
  return { created: true };
}
