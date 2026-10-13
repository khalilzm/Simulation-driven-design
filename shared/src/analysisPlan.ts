import { parseSunlightConfig, type SunlightConfig } from './sunlight';
import { parsePedestrianConfig, type PedestrianConfig } from './pedestrian';
import { daylightSettingsError, type DaylightConfig } from './daylight';

export type AnalysisStep = (
  | { capability: 'sunlight'; config: SunlightConfig }
  | { capability: 'pedestrian'; config: PedestrianConfig }
  | { capability: 'daylight'; config: DaylightConfig }) & { moduleId?: string; moduleVersion?: string };

export interface AnalysisPlan { schemaVersion: '1'; steps: AnalysisStep[] }

/** Validate the entire plan before execution. An empty plan intentionally invokes no engines. */
export function parseAnalysisPlan(raw: unknown): AnalysisPlan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('分析计划必须为对象');
  const plan = raw as AnalysisPlan;
  if (plan.schemaVersion !== '1' || !Array.isArray(plan.steps) || plan.steps.length > 128) throw new Error('分析计划版本或步骤数量无效');
  const seen = new Set<string>();
  const steps = plan.steps.map((step): AnalysisStep => {
    if (!step || typeof step !== 'object' || !['sunlight','pedestrian','daylight'].includes(step.capability)) throw new Error('不支持的分析能力');
    if (step.moduleId !== undefined && (typeof step.moduleId !== 'string' || !/^[A-Za-z][\w-]{0,99}$/.test(step.moduleId))) throw new Error('仿真模块标识无效');
    if (step.moduleVersion !== undefined && (typeof step.moduleVersion !== 'string' || !step.moduleVersion.trim() || step.moduleVersion.length > 100)) throw new Error('仿真模块版本无效');
    const id = step.moduleId ?? step.capability;
    if (seen.has(id)) throw new Error('仿真模块标识重复；同一能力的多个工况须使用不同 moduleId');
    seen.add(id);
    const binding = { ...(step.moduleId === undefined ? {} : { moduleId: step.moduleId }),
      ...(step.moduleVersion === undefined ? {} : { moduleVersion: step.moduleVersion }) };
    if (step.capability === 'sunlight') {
      const parsed = parseSunlightConfig(step.config);
      if (!parsed.ok) throw new Error(parsed.errors.join('；'));
      return { ...binding, capability: step.capability, config: parsed.config };
    }
    if (step.capability === 'pedestrian') {
      const parsed = parsePedestrianConfig(step.config);
      if (!parsed.ok) throw new Error(parsed.errors.join('；'));
      return { ...binding, capability: step.capability, config: parsed.config };
    }
    const config = step.config;
    const invalid = daylightSettingsError(config);
    if (invalid) throw new Error(invalid);
    if (config.schemaVersion !== '1' || !Array.isArray(config.targets)) throw new Error('采光工况版本或目标无效');
    const ids = new Set<string>();
    for (const target of config.targets) {
      if (!target || typeof target.roomId !== 'string' || !target.roomId || ids.has(target.roomId)
        || !Number.isFinite(target.minIlluminanceLux) || target.minIlluminanceLux < 1 || target.minIlluminanceLux > 100000
        || !Number.isFinite(target.minAreaRatio) || target.minAreaRatio <= 0 || target.minAreaRatio > 1
        || !['hard','soft'].includes(target.priority)) throw new Error('采光房间目标无效或重复');
      ids.add(target.roomId);
    }
    return { ...binding, capability: step.capability, config: structuredClone(config) };
  });
  return structuredClone({ schemaVersion: '1', steps });
}
