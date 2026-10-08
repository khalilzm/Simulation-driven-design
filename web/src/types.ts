import type { SpaceModel, SunlightResult, PedestrianResult } from '@sdd/shared';
import type { SunlightColorScale } from './viewer/sunlightColor';

export type ModelDisplayMode = 'usage' | 'sunlight' | 'pedestrian';
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
}

export type DxfEntity =
  | { kind: 'polyline'; points: [number, number][]; closed?: boolean }
  | { kind: 'circle'; center: [number, number]; radius: number }
  | { kind: 'arc'; center: [number, number]; radius: number; startAngle: number; endAngle: number };

export type ViewerContent =
  | { kind: 'empty' }
  | { kind: 'dxf'; entities: DxfEntity[] }
  | { kind: 'model'; model: SpaceModel; view?: ModelViewMode; sunlight?: SunlightResult; pedestrian?: PedestrianResult;
      comparison?: { sunlightScale: SunlightColorScale; densityScale: SunlightColorScale; pedestrianTimeMax: number } };
