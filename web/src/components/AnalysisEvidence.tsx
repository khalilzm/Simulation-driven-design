import type { OptimizationRun, SpaceModel } from '@sdd/shared';
import { resolveSpaceLabel } from '@sdd/shared';

function spaceLabel(model: SpaceModel, spaceId: string): string {
  const space = model.spaces.find((s) => s.id === spaceId);
  return space ? resolveSpaceLabel(space, model.spaceTypes) || space.id : spaceId;
}

interface Diagnosis {
  id: string;
  title: string;
  severity: 'warn' | 'info';
  spaceId?: string;
  observation: string;
  hypothesis: string;
  operation: string;
  verification: string;
}

/** 从基线指标按 docs/simulation-driven-update.md §6 的映射推导诊断：观察与原因假设分层。 */
function deriveDiagnoses(model: SpaceModel, run: OptimizationRun): Diagnosis[] {
  const baseline = run.baseline;
  if (!baseline) return [];
  const diagnoses: Diagnosis[] = [];

  for (const space of baseline.sunlight.spaces) {
    if (space.targetMetRatio != null && space.targetMetRatio < 1) {
      diagnoses.push({
        id: `sun-${space.spaceId}`,
        title: `${spaceLabel(model, space.spaceId)}日照不足`,
        severity: 'warn',
        spaceId: space.spaceId,
        observation: `目标达标面积比例 ${(space.targetMetRatio * 100).toFixed(0)}%，加权平均 ${space.meanHours.toFixed(2)} h（${space.sensorCount} 测点）`,
        hypothesis: '隔墙或朝向阻挡了部分入射路径',
        operation: '小幅移动已标记可改的隔墙，或交换功能位置',
        verification: '同工况重算该空间及所有受保护空间日照',
      });
    }
  }

  const ped = baseline.pedestrian;
  if (ped.egressTimeSec == null) {
    diagnoses.push({
      id: 'ped-egress',
      title: '疏散未在时长上限内完成',
      severity: 'warn',
      observation: `${ped.totalAgents} 人未能在 ${run.configs.pedestrian.maxDurationSec}s 内清空`,
      hypothesis: '起点到出口不可达，或出口选择、宽度受限',
      operation: '新增被允许的内部门洞，或调整门宽/门位',
      verification: '先做连通与净空检查，再跑同工况疏散',
    });
  } else {
    diagnoses.push({
      id: 'ped-egress',
      title: '出口疏散时间',
      severity: 'info',
      observation: `${ped.totalAgents} 人清空时间 ${ped.egressTimeSec.toFixed(2)}s`,
      hypothesis: '门洞宽度限制或汇流导致排队',
      operation: '门宽/门位变化，或局部通道调整',
      verification: '同人数、同策略重算轨迹密度与清空时间',
    });
  }

  return diagnoses;
}

export function AnalysisEvidence({ run, model, onFocusSpace }: {
  run: OptimizationRun;
  model: SpaceModel;
  onFocusSpace?: (spaceId: string) => void;
}) {
  const baseline = run.baseline;
  if (!baseline) return null;

  const { sunlight: sun, pedestrian: ped } = run.configs;
  const sunResult = baseline.sunlight;
  const pedResult = baseline.pedestrian;
  const targetRatio = sunResult.targetAreaRatio;
  const diagnoses = deriveDiagnoses(model, run);
  const agents = ped.agents.reduce((n, a) => n + a.count, 0);

  return (
    <section className="analysis-evidence" aria-label="仿真分析证据">
      <div className="evidence-scenario">
        <div className="evidence-scenario-line">
          日照 · {sun.location.latitude.toFixed(2)}°N {sun.location.longitude.toFixed(2)}°E · {sun.analysisDate}{' '}
          {sun.localTimeRange.join('–')} · 北向 {sun.northDegrees}° · 网格 {sun.sensors.gridSpacing}m
        </div>
        <div className="evidence-scenario-line">
          疏散 · {agents} 人 · 种子 {ped.seed} · 上限 {ped.maxDurationSec}s
        </div>
        <div className="evidence-scenario-line evidence-scenario-engine">
          引擎 · 日照 {sunResult.engineVersion} · 疏散 {pedResult.engineVersion}
        </div>
      </div>

      <div className="evidence-metrics">
        <div className="evidence-metric">
          <span className="evidence-metric-label">日照达标面积</span>
          <span className="evidence-metric-value">{targetRatio != null ? `${(targetRatio * 100).toFixed(0)}%` : '未配置目标'}</span>
        </div>
        <div className="evidence-metric">
          <span className="evidence-metric-label">清空时间</span>
          <span className="evidence-metric-value">{pedResult.egressTimeSec != null ? `${pedResult.egressTimeSec.toFixed(2)}s` : '未清空'}</span>
        </div>
        <div className="evidence-metric">
          <span className="evidence-metric-label">疏散人数</span>
          <span className="evidence-metric-value">{pedResult.totalAgents} 人</span>
        </div>
      </div>

      {diagnoses.length > 0 && (
        <div className="diagnosis-list" aria-label="诊断">
          {diagnoses.map((d) => {
            const focusable = !!d.spaceId && !!onFocusSpace;
            return (
              <div
                key={d.id}
                className={`diagnosis-card ${d.severity}${focusable ? ' focusable' : ''}`}
                role={focusable ? 'button' : undefined}
                tabIndex={focusable ? 0 : undefined}
                onClick={focusable ? () => onFocusSpace!(d.spaceId!) : undefined}
                onKeyDown={focusable ? (e) => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); onFocusSpace!(d.spaceId!); } } : undefined}
              >
                <div className="diagnosis-title">
                  {d.title}
                  {focusable && <span className="diagnosis-locate">定位</span>}
                </div>
                <div className="diagnosis-row"><span className="diagnosis-label">观察</span><span className="diagnosis-text">{d.observation}</span></div>
                <div className="diagnosis-row"><span className="diagnosis-label">假设</span><span className="diagnosis-text">{d.hypothesis}</span></div>
                <div className="diagnosis-row"><span className="diagnosis-label">操作</span><span className="diagnosis-text">{d.operation}</span></div>
                <div className="diagnosis-row"><span className="diagnosis-label">验证</span><span className="diagnosis-text">{d.verification}</span></div>
              </div>
            );
          })}
        </div>
      )}
      {diagnoses.length === 0 && (
        <p className="evidence-empty">未发现明显的日照或疏散问题，可继续发起优化或调整目标。</p>
      )}
    </section>
  );
}
