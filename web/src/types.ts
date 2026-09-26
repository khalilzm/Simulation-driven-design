import type { SpaceModel, SunlightResult } from '@sdd/shared';

export type ModelViewMode = 'usage' | 'sunlight';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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
  | { kind: 'model'; model: SpaceModel; view?: ModelViewMode; sunlight?: SunlightResult };
