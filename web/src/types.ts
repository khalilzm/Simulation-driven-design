import type { CanvasModule, CapabilityId, SpaceModel, DaylightResult, SunlightResult, PedestrianResult } from '@sdd/shared';
import type { SunlightColorScale } from './viewer/sunlightColor';

export type AnalysisDisplayMode = Extract<CapabilityId, 'daylight' | 'sunlight' | 'pedestrian'>;
export type ModelDisplayMode = 'usage' | AnalysisDisplayMode;
export type ModelViewMode = ModelDisplayMode | '3d';

export interface ChatImageAttachment {
  url: string;
  alt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: ChatImageAttachment[];
  status?: 'thinking' | 'done' | 'failed';
  progress?: string;
  thinking?: string;
  artifact?: { module: CanvasModule; revisionId?: string };
  artifacts?: { module: CanvasModule; revisionId?: string }[];
  /** UI-only status messages (e.g. successful file import) are not restored as conversation history. */
  ephemeral?: boolean;
}

export type DxfEntity =
  | { kind: 'polyline'; points: [number, number][]; closed?: boolean }
  | { kind: 'circle'; center: [number, number]; radius: number }
  | { kind: 'arc'; center: [number, number]; radius: number; startAngle: number; endAngle: number };

export type ViewerContent =
  | { kind: 'empty' }
  | { kind: 'dxf'; entities: DxfEntity[] }
  | { kind: 'model'; model: SpaceModel; view?: ModelViewMode; sunlight?: SunlightResult; daylight?: DaylightResult; pedestrian?: PedestrianResult;
      comparison?: { sunlightScale: SunlightColorScale; densityScale: SunlightColorScale; pedestrianTimeMax: number } };

export type ViewerModelContent = Extract<ViewerContent, { kind: 'model' }>;
