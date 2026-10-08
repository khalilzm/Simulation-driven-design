import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(moduleDir, '..');
const repoRoot = path.resolve(serverDir, '..');

// 按 config.ts 位置加载 server/.env，不依赖进程 cwd
try {
  process.loadEnvFile(path.join(serverDir, '.env'));
} catch {
  // .env 不存在时使用默认值
}

/** SDK 将空字符串 CURSOR_API_KEY 视为显式无凭证，不会回退到 Cursor.auth.login() 登录态 */
export function sanitizeCursorApiKeyEnv(): void {
  if (!process.env.CURSOR_API_KEY?.trim()) {
    delete process.env.CURSOR_API_KEY;
  }
}

sanitizeCursorApiKeyEnv();

export interface AppConfig {
  port: number;
  host: string;
  claudePath: string;
  model: string;
  cursorApiKey: string;
  cursorModel: string;
  /** 日照 Python 解释器，默认 python3 */
  sunlightPython: string;
  /** 为 true 时优先使用 Honeybee Radiance direct-sun-hours（需本机 Radiance） */
  sunlightUseRadiance: boolean;
  /** Radiance 可执行目录（rtrace/oconv）；子进程 PATH 前置 */
  sunlightRadianceBin: string;
  /** 人流疏散 Python 解释器，默认 python3 */
  pedestrianPython: string;
}

const bundledRadianceBin = path.join(
  repoRoot,
  'server',
  'python',
  'sunlight',
  'vendor',
  'radiance',
  'radiance',
  'bin',
);

function resolveSunlightRadianceBin(): string {
  const fromEnv = process.env.SDD_SUNLIGHT_RADIANCE_BIN?.trim();
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(serverDir, fromEnv);
  }
  if (fs.existsSync(path.join(bundledRadianceBin, 'rtrace'))) {
    return bundledRadianceBin;
  }
  return '';
}

const defaultSunlightVenvPython = path.join(serverDir, 'python', 'sunlight', '.venv', 'bin', 'python3');

function resolveSunlightPython(): string {
  const fromEnv = process.env.SDD_SUNLIGHT_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(defaultSunlightVenvPython)) return defaultSunlightVenvPython;
  return 'python3';
}

const defaultPedestrianVenvPython = path.join(serverDir, 'python', 'pedestrian', '.venv', 'bin', 'python3');

function resolvePedestrianPython(): string {
  const fromEnv = process.env.SDD_PEDESTRIAN_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  if (fs.existsSync(defaultPedestrianVenvPython)) return defaultPedestrianVenvPython;
  return 'python3';
}

function resolveSunlightUseRadiance(radianceBin: string): boolean {
  const flag = process.env.SDD_SUNLIGHT_USE_RADIANCE?.trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  // 仓库内已放置 Radiance + venv 时默认与 GH「HB Direct Sun Hours」一致
  return Boolean(radianceBin) && fs.existsSync(defaultSunlightVenvPython);
}

export { repoRoot };

const sunlightRadianceBin = resolveSunlightRadianceBin();
const sunlightUseRadiance = resolveSunlightUseRadiance(sunlightRadianceBin);

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 4317),
  host: process.env.HOST ?? '127.0.0.1',
  claudePath: process.env.CLAUDE_PATH ?? 'claude',
  model: process.env.MODEL ?? '',
  cursorApiKey: process.env.CURSOR_API_KEY ?? '',
  cursorModel: process.env.CURSOR_MODEL ?? 'composer-2.5',
  sunlightPython: resolveSunlightPython(),
  sunlightRadianceBin,
  sunlightUseRadiance,
  pedestrianPython: resolvePedestrianPython(),
};

/** Node 调用日照 Python 时的环境（Radiance PATH + recipe 开关） */
export function sunlightProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (config.sunlightUseRadiance) {
    env.SDD_SUNLIGHT_USE_RADIANCE = '1';
  }
  if (config.sunlightRadianceBin) {
    const radianceHome = path.dirname(config.sunlightRadianceBin);
    env.PATH = `${config.sunlightRadianceBin}${path.delimiter}${env.PATH ?? ''}`;
    env.BINPATH = config.sunlightRadianceBin;
    env.SDD_RADIANCE_PATH = radianceHome;
    env.RAYPATH = path.join(radianceHome, 'lib');
  }
  return env;
}

export const sunlightEngineId = sunlightUseRadiance
  ? 'lbt-direct-sun-hours@2'
  : 'ladybug-lb-direct-sun-hours@3';

export const sunlightRunnerScript = path.join(repoRoot, 'server', 'python', 'sunlight', 'sdd_run.py');

export const pedestrianEngineId = 'jupedsim-egress@1';

export const pedestrianRunnerScript = path.join(repoRoot, 'server', 'python', 'pedestrian', 'sdd_run.py');

export const workspacesDir = process.env.WORKSPACES_DIR
  ? path.resolve(process.env.WORKSPACES_DIR)
  : path.join(repoRoot, 'workspaces');
