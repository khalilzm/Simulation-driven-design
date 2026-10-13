export const CANVAS_MODULES = ['dxf', 'graph', 'metrics', 'scheme'] as const;
export type CanvasModule = typeof CANVAS_MODULES[number];
export const MODULE_TITLES: Record<CanvasModule, string> = {
  dxf: 'DXF 底图', graph: '空间节点图', metrics: '仿真指标', scheme: '生成方案',
};
export const moduleShapeId = (module: CanvasModule) => `shape:module-${module}`;

/** Presentation containers only. A metrics board can contain many independently configured simulation modules. */
export interface WorkspaceCanvasDocument {
  schemaVersion: 2;
  snapshot: Record<string, unknown>;
  activeModules: CanvasModule[];
  updatedAt: string;
}

export function canvasSnapshotModules(value: unknown): CanvasModule[] {
  const document = (value as { document?: { store?: unknown } })?.document;
  if (!document?.store || typeof document.store !== 'object' || Array.isArray(document.store)) return [];
  const records = Object.values(document.store) as { id?: string; type?: string; props?: { module?: string } }[];
  return CANVAS_MODULES.filter(module => records.some(record => record?.type === 'module-board'
    && record.id === moduleShapeId(module) && record.props?.module === module));
}

export function validateCanvasSnapshot(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '画布快照必须是对象';
  const store = (value as { document?: { store?: unknown } }).document?.store;
  if (!store || typeof store !== 'object' || Array.isArray(store)) return '缺少画布文档';
  const records = Object.values(store) as { id?: string; type?: string; props?: { module?: string } }[];
  const boards = records.filter(record => record?.type === 'module-board');
  if (boards.length > CANVAS_MODULES.length) return '画布模块白板数量超出上限';
  const seen = new Set<string>();
  for (const board of boards) {
    if (!CANVAS_MODULES.includes(board.props?.module as CanvasModule) || board.id !== moduleShapeId(board.props?.module as CanvasModule)
      || seen.has(board.props!.module!)) return '画布模块白板标识无效或重复';
    seen.add(board.props!.module!);
  }
  return null;
}
