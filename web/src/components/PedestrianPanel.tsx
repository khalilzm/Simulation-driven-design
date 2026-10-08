import type { PedestrianConfig, PedestrianResult, SpaceModel } from '@sdd/shared';
import { resolveSpaceLabel } from '@sdd/shared';

function spaceLabel(model: SpaceModel | undefined, spaceId: string): string {
  if (!model) return spaceId;
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return spaceId;
  return resolveSpaceLabel(space, model.spaceTypes) || space.usage || spaceId;
}

export function PedestrianPanel({
  model,
  config,
  result,
  pythonOk,
  busy,
  canRun,
  onRun,
  onShowMap,
}: {
  model?: SpaceModel;
  config?: PedestrianConfig | null;
  result?: PedestrianResult;
  pythonOk?: boolean;
  busy: boolean;
  canRun: boolean;
  onRun: () => void;
  onShowMap: () => void;
}) {
  const metrics = result?.status === 'completed' ? result.metrics : null;

  return (
    <div className="sunlight-panel">
      <div className="sunlight-panel-header">
        <span className="sunlight-panel-title">人流疏散分析</span>
        <button type="button" onClick={onRun} disabled={busy || !canRun || pythonOk === false}>
          {busy ? '计算中…' : '运行疏散'}
        </button>
      </div>
      {pythonOk === false && (
        <p className="sunlight-hint warn">
          本机未检测到 JuPedSim Python 环境，请安装 server/python/pedestrian/requirements.txt
        </p>
      )}
      {!canRun && (
        <p className="sunlight-hint">请先保存或选择一版方案。首次运行将按面积自动写入默认 pedestrian.json。</p>
      )}
      {canRun && config && (
        <p className="sunlight-hint">
          疏散人数 {config.agents.reduce((sum, a) => sum + a.count, 0)} 人 · {config.agents.length} 个空间 · 上限 {config.maxDurationSec}s
        </p>
      )}
      {metrics && (
        <>
          <div className="sunlight-verification review">
            疏散完成{metrics.egressTimeSec != null ? `（RSET ${metrics.egressTimeSec}s）` : '（超时未清空）'}
          </div>
          <button type="button" className="sunlight-map-link" onClick={onShowMap}>
            在右侧查看密度热力图与轨迹
          </button>
          <table className="sunlight-table">
            <tbody>
              <tr>
                <td>总人数</td>
                <td>{metrics.totalAgents}</td>
              </tr>
              <tr>
                <td>平均疏散时间</td>
                <td>{metrics.meanEgressTimeSec != null ? `${metrics.meanEgressTimeSec}s` : '—'}</td>
              </tr>
            </tbody>
          </table>
          {metrics.peakDoorDensity.length > 0 && (
            <table className="sunlight-table">
              <thead>
                <tr>
                  <th>出口</th>
                  <th>峰值密度</th>
                  <th>通过率</th>
                </tr>
              </thead>
              <tbody>
                {metrics.peakDoorDensity.map((d) => (
                  <tr key={d.exitId}>
                    <td>{d.exitId}</td>
                    <td>{d.peakDensity.toFixed(2)} 人/㎡</td>
                    <td>{d.flowRate.toFixed(2)} 人/s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {metrics.bottleneckSpaceIds.length > 0 && (
            <p className="sunlight-hint warn">
              拥堵空间：{metrics.bottleneckSpaceIds.map((id) => spaceLabel(model, id)).join('、')}
            </p>
          )}
        </>
      )}
      {result && result.status !== 'completed' && (
        <p className="sunlight-hint warn">{result.error ?? '疏散计算失败'}</p>
      )}
    </div>
  );
}
