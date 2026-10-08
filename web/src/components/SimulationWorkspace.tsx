import type { OptimizationComparison, OptimizationSetup, ProviderId, SpaceModel } from '@sdd/shared';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { OptimizationPanel } from './OptimizationPanel';
import { SimulationConfigPanel } from './SimulationConfigPanel';

export function SimulationWorkspace({
  revisionId,
  model,
  setup,
  sessionId,
  provider,
  busy,
  blockedReason,
  notice,
  viewer,
  onBack,
  onBusyChange,
  onCompare,
  onFocusSpace,
  beforeStart,
  onConfigs,
}: {
  revisionId: string;
  model: SpaceModel;
  setup: OptimizationSetup;
  sessionId: string;
  provider: ProviderId;
  busy: boolean;
  blockedReason?: string;
  notice?: string;
  viewer: ReactNode;
  onBack: () => void;
  onBusyChange: (busy: boolean) => void;
  onCompare: (comparison: OptimizationComparison | null) => void;
  onFocusSpace?: (spaceId: string) => void;
  beforeStart: () => Promise<void>;
  onConfigs: (configs: OptimizationSetup['configs']) => void;
}) {
  const [showSimulationConfig, setShowSimulationConfig] = useState(true);

  useEffect(() => {
    setShowSimulationConfig(true);
  }, [revisionId]);

  return (
    <div className="simulation-screen">
      <header className="simulation-topbar">
        <button type="button" className="simulation-back" disabled={busy} onClick={onBack}>
          ← 返回方案
        </button>
        <div className="simulation-topbar-title">
          <h1>仿真优化</h1>
          <p>
            基线方案 {revisionId}
            {showSimulationConfig
              ? ' · 设定工况后点击「分析优化」'
              : ' · 左侧查看进度与结果，右侧查看平面与仿真图层'}
          </p>
        </div>
      </header>
      {notice && <div className="simulation-notice" role="status">{notice}</div>}
      <div className="simulation-body">
        <aside
          className={`simulation-workspace${showSimulationConfig ? '' : ' simulation-workspace--analysis'}`}
          aria-label={showSimulationConfig ? '仿真工况与优化' : '分析优化'}
        >
          {showSimulationConfig && (
            <SimulationConfigPanel model={model} setup={setup} busy={busy} onConfigs={onConfigs} />
          )}
          <OptimizationPanel
            sessionId={sessionId}
            revisionId={revisionId}
            provider={provider}
            model={model}
            busy={busy}
            blockedReason={blockedReason}
            onBusyChange={onBusyChange}
            onConfigsReady={() => {}}
            onCompare={onCompare}
            onFocusSpace={onFocusSpace}
            beforeStart={beforeStart}
            onOptimizationStart={() => setShowSimulationConfig(false)}
            showConfigSettings={showSimulationConfig}
            onShowConfigSettings={() => setShowSimulationConfig(true)}
          />
        </aside>
        <main className="simulation-viewer">{viewer}</main>
      </div>
    </div>
  );
}
