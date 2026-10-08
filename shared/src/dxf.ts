import type { SpaceModel, Unit } from './model';

/** The fixed-envelope DXF contract uses model-space closed polylines on these layers. */
export const DXF_LAYERS = {
  outline: 'FIXED_OUTLINE',
  wall: 'FIXED_LOAD_BEARING',
  entrance: 'FIXED_ENTRANCE',
  window: 'FIXED_WINDOW',
} as const;

export interface DxfSource {
  filename: string;
  sourceUnits: Unit;
  widthM: number;
  depthM: number;
  areaM2: number;
  counts: { outlines: number; loadBearingWalls: number; entrances: number; windows: number };
  warnings: string[];
}

export interface DxfUploadResponse {
  sessionId: string;
  file: { name: string; size: number };
  revisionId: string;
  model: SpaceModel;
}
