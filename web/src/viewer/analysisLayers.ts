import type { PedestrianResult } from '@sdd/shared';
import type { AnalysisDisplayMode, ModelViewMode, ViewerModelContent } from '../types';
import type { PolygonFill } from './modelRender';
import { daylightGridsToFills, sunlightGridsToFills } from './sunlightMeshRender';
import { pedestrianDensityToFills } from './pedestrianMeshRender';
import { trajectoriesToLineGroups, type TrajectoryLineGroup } from './pedestrianTrajectories';

export interface AnalysisLayerGeometry {
  fills: PolygonFill[];
  lines: TrajectoryLineGroup[];
  playback?: PedestrianResult;
}
export interface ViewerAnalysisLayer {
  id: AnalysisDisplayMode;
  label: string;
  unit: 'lx' | 'h' | '人/㎡';
  description: string;
  emptyMessage: string;
  isCompleted(content: ViewerModelContent): boolean;
  geometry(content: ViewerModelContent): AnalysisLayerGeometry;
}
const emptyGeometry = (): AnalysisLayerGeometry => ({ fills: [], lines: [] });

/** Presentation adapters belong to capabilities, never to a building use or scenario. */
export const ANALYSIS_LAYERS: Readonly<Record<AnalysisDisplayMode, ViewerAnalysisLayer>> = {
  daylight: {
    id: 'daylight', label: '室内采光', unit: 'lx',
    description: '标准阴天天空 · 室内照度（lx） · 色标上限1000 lx',
    emptyMessage: '运行采光评价后查看照度热力图',
    isCompleted: content => content.daylight?.status === 'completed',
    geometry: content => content.daylight?.status === 'completed'
      ? { fills: daylightGridsToFills(content.daylight), lines: [] } : emptyGeometry(),
  },
  sunlight: {
    id: 'sunlight', label: '日照时长', unit: 'h',
    description: '直射日照 · 传感器网格累计时长（h）',
    emptyMessage: '运行日照后查看时长着色',
    isCompleted: content => content.sunlight?.status === 'completed',
    geometry: content => content.sunlight?.status === 'completed'
      ? { fills: sunlightGridsToFills(content.sunlight, content.comparison?.sunlightScale), lines: [] } : emptyGeometry(),
  },
  pedestrian: {
    id: 'pedestrian', label: '人流疏散', unit: '人/㎡',
    description: '人流疏散 · 峰值密度（人/㎡）+ 轨迹线 + 圆点回放',
    emptyMessage: '运行疏散后在此查看密度热力图与轨迹',
    isCompleted: content => content.pedestrian?.status === 'completed',
    geometry: content => content.pedestrian?.status === 'completed' ? {
      fills: pedestrianDensityToFills(content.pedestrian, content.comparison?.densityScale),
      lines: trajectoriesToLineGroups(content.pedestrian, content.comparison?.pedestrianTimeMax),
      playback: content.pedestrian,
    } : emptyGeometry(),
  },
};
export const registeredAnalysisLayers = (): readonly ViewerAnalysisLayer[] => Object.values(ANALYSIS_LAYERS);
export function analysisLayerForView(view?: ModelViewMode): ViewerAnalysisLayer | undefined {
  return view && Object.hasOwn(ANALYSIS_LAYERS, view) ? ANALYSIS_LAYERS[view as AnalysisDisplayMode] : undefined;
}
