import { lazy, Suspense, useMemo } from 'react';
import { type ResidentialBrief, type SpaceModel } from '@sdd/shared';

const Viewer = lazy(() => import('../viewer/Viewer').then(module => ({ default: module.Viewer })));
const SpaceGraphCanvas = lazy(() => import('../scenarios/residential/SpaceGraphCanvas').then(module => ({ default: module.SpaceGraphCanvas })));
const noop = () => {};
const loading = <div className="module-empty" role="status">正在加载画布…</div>;

export function PlanPreview({ model, fixedOnly = false }: { model?: SpaceModel; fixedOnly?: boolean }) {
  const content = useMemo(() => model ? { kind: 'model' as const, model } : undefined, [model]);
  if (!content) return <div className="module-empty"><span className="module-empty__symbol" aria-hidden>⌑</span><strong>{fixedOnly ? '等待上传 DXF' : '等待生成方案'}</strong><p>{fixedOnly ? '导入底图，读取固定轮廓与构件' : '向 Agent 描述布局和设计目标'}</p></div>;
  return <div className="module-render-preview module-plan-preview" aria-label={fixedOnly ? 'DXF 实际渲染画布' : '方案实际渲染画布'}>
    <Suspense fallback={loading}><Viewer content={content} displayMode="usage" show3d={false} embedded onDisplayModeChange={noop} onShow3dChange={noop} /></Suspense>
  </div>;
}

export function GraphPreview({ brief }: { brief?: ResidentialBrief; model?: SpaceModel }) {
  const roomOnlyBrief = useMemo(() => brief ? { ...brief, relations: brief.relations.filter(relation => !relation.from.startsWith('entrance:') && !relation.to.startsWith('entrance:')) } : undefined, [brief]);
  if (!brief?.rooms.length) return <div className="module-empty"><span className="module-empty__symbol" aria-hidden>⌘</span><strong>等待空间需求</strong><p>定义房间、面积范围和邻接关系</p></div>;
  return <div className="module-render-preview module-graph-preview" aria-label="实际空间节点画布">
    <Suspense fallback={loading}><SpaceGraphCanvas brief={roomOnlyBrief!} anchors={[]} disabled preview storageKey="sdd.graph.preview" onMove={noop} onSelectNode={noop} onSelectEdge={noop} onConnect={noop} onDelete={noop} onCancel={noop} /></Suspense>
  </div>;
}
