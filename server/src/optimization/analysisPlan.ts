import { parseAnalysisPlan, type AnalysisPlan, type OptimizationRun } from '@sdd/shared';

/** This comparison policy protects direct sun and minimizes egress; other scenes choose other plans. */
export function optimizationAnalysisPlan(configs: OptimizationRun['configs']): AnalysisPlan {
  return parseAnalysisPlan({ schemaVersion: '1', steps: [
    { capability: 'sunlight', config: configs.sunlight },
    { capability: 'pedestrian', config: configs.pedestrian },
  ] });
}

export function resolveOptimizationAnalysisPlan(run: Pick<OptimizationRun, 'configs' | 'analysisPlan'>): AnalysisPlan {
  const plan = parseAnalysisPlan(run.analysisPlan ?? optimizationAnalysisPlan(run.configs));
  const expected = optimizationAnalysisPlan(run.configs);
  if (plan.steps.length !== expected.steps.length || expected.steps.some(required =>
    !plan.steps.some(step => step.capability === required.capability && JSON.stringify(step.config) === JSON.stringify(required.config)))) {
    throw new Error('当前优化比较策略需要同工况的日照与疏散分析；其他能力组合须使用对应场景评价策略');
  }
  return plan;
}
