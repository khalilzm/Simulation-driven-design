import type { SpaceModel, Vec2 } from './model';

export type SpaceTaskMode = 'sketch' | 'generate' | 'edit';

/** Immutable upload. Coordinates refer to the EXIF-oriented, normalized PNG. */
export interface SketchSource {
  id: string;
  originalName: string;
  originalPath: string;
  imagePath: string;
  sha256: string;
  width: number;
  height: number;
  createdAt: string;
  /** Decode, orient, resize, encode and save the image; excludes client upload/network time. */
  preparationMs?: number;
}

export interface SketchWall {
  id: string;
  points: Vec2[];
  thicknessPx: number | null;
  /** Prefer an explicit real-world wall thickness annotation to measuring the stroke. */
  thicknessM?: number | null;
}

export interface SketchOpening {
  id: string;
  kind: 'door' | 'window' | 'passage' | 'unknown';
  wallId: string;
  /** Fraction of the directed wall polyline length, measured to opening centre. */
  position: number;
  widthPx: number;
  heightM: number | null;
  sillHeightM: number | null;
  hinge: 'start' | 'end' | null;
  /** Side of directed wall in IMAGE coordinates (x right, y down). */
  opensTo: 'left' | 'right' | null;
  leafCount: 1 | 2 | null;
}

export interface SketchLabel {
  id: string;
  text: string;
  usage: string | null;
  /** 'function' for room/area names, 'dimension' for verbatim dimension-number text (e.g. 3600, 3.6m). */
  kind: 'function' | 'dimension';
  point: Vec2;
}

export interface SketchExtraction {
  schemaVersion: 1;
  sketchId: string;
  coordinateSystem: 'image-pixels';
  walls: SketchWall[];
  openings: SketchOpening[];
  labels: SketchLabel[];
  /** Explicitly observed functional divisions; these never create physical walls. */
  dividers: { id: string; points: [Vec2, Vec2]; evidence: string }[];
  dimensions: { id: string; points: [Vec2, Vec2]; lengthM: number; text: string }[];
  heightM: number | null;
  uncertainties: { id: string; objectId: string | null; message: string; point: Vec2 | null }[];
}

export interface SketchIssue {
  id: string;
  objectId?: string;
  severity: 'error' | 'review' | 'info';
  message: string;
  point?: Vec2;
}

export interface SketchCompilation {
  model?: SpaceModel;
  issues: SketchIssue[];
  adjustments: { objectId: string; from: Vec2; to: Vec2; distancePx: number }[];
  mapping: Record<string, string[]>;
  metersPerPixel: number;
  calibrated: boolean;
  normalized: SketchExtraction;
}

/** Historical reports only; new runs do not invoke automatic visual review. */
export interface SketchVisualReview {
  schemaVersion: 1;
  sketchId: string;
  /** Bound to the exact extraction, never reused after a patch. */
  extractionHash: string;
  findings: { id: string; objectId: string | null; message: string; point: Vec2 | null }[];
}

export interface AgentTurnTimings {
  totalMs: number;
  authMs?: number;
  initializeMs?: number;
  attachmentsMs?: number;
  sendMs?: number;
  runMs?: number;
  disposeMs?: number;
  /** Measured from send start; milestones inside sendMs/runMs, not additive stages. */
  firstContentMs?: number;
  afterLastToolMs?: number;
}

export interface SketchStageTiming {
  phase: 'recognize' | 'patch' | 'parse' | 'compile' | 'overlay' | 'persist';
  attempt: number;
  startedAt: string;
  durationMs: number;
  outcome: 'completed' | 'failed';
  provider?: AgentTurnTimings;
}

export interface SketchTimings {
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  stages: SketchStageTiming[];
}

export interface SketchReport {
  source: SketchSource;
  revisionId: string;
  status: 'accepted' | 'needs_review' | 'rejected';
  geometryValid: boolean;
  calibrated: boolean;
  metersPerPixel: number;
  extractionHash?: string;
  extraction?: SketchExtraction;
  issues: SketchIssue[];
  adjustments: SketchCompilation['adjustments'];
  mapping: Record<string, string[]>;
  visualReview?: SketchVisualReview;
  overlayPath?: string;
  model?: SpaceModel;
  confirmation?: { at: string; parentRevisionId: string; issueIds: string[] };
  timings?: SketchTimings;
}
