import type { ComponentType } from 'react';
import type { AnalysisDisplayMode, ViewerModelContent } from '../types';
import { ANALYSIS_LAYERS } from './analysisLayers';
import { DaylightLegend } from './DaylightLegend';
import { SunlightLegend } from './SunlightLegend';
import { PedestrianLegend } from './PedestrianLegend';

const LEGENDS: Record<AnalysisDisplayMode, ComponentType<{ content: ViewerModelContent }>> = {
  daylight: ({ content }) => content.daylight ? <DaylightLegend result={content.daylight} /> : null,
  sunlight: ({ content }) => content.sunlight ? <SunlightLegend result={content.sunlight} scale={content.comparison?.sunlightScale} /> : null,
  pedestrian: ({ content }) => content.pedestrian ? <PedestrianLegend result={content.pedestrian} scale={content.comparison?.densityScale} /> : null,
};
export function AnalysisLegend({ capability, content }: { capability: AnalysisDisplayMode; content: ViewerModelContent }) {
  if (!ANALYSIS_LAYERS[capability].isCompleted(content)) return null;
  const Legend = LEGENDS[capability];
  return <Legend content={content} />;
}
