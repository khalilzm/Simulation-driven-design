import type { Vec2 } from './model';

export interface StructuralWallInterval {
  segment: [Vec2, Vec2];
  length: number;
  leftSpaceId?: string;
  rightSpaceId?: string;
  status: 'separator' | 'same_space' | 'intentional' | 'junction' | 'unassigned';
}
export interface StructuralWallReview {
  wallId: string;
  length: number;
  separatorLength: number;
  sameSpaceLength: number;
  unexplainedLength: number;
  purpose?: string;
  intervals: StructuralWallInterval[];
}
export interface StructuralWallRelationships {
  walls: StructuralWallReview[];
  unexplainedLength: number;
  warnings: string[];
  penalty: number;
}
export interface PublicSpaceReview {
  spaceId: string;
  name: string;
  area: number;
  coreArea: number;
  coreBoundary: Vec2[];
  coreRatio: number;
  fragmentationArea: number;
  penalty: number;
}
export interface WallAlignmentStep {
  wallIds: [string, string];
  connectorWallId: string;
  spaceId: string;
  offset: number;
  segment: [Vec2, Vec2];
}
export interface WallAlignmentReview {
  steps: WallAlignmentStep[];
  totalOffset: number;
  warnings: string[];
  penalty: number;
}
export interface StructuralWallConnection {
  structuralWallId: string;
  partitionWallId: string;
  kind: 'continuation' | 'tee' | 'corner';
  point: Vec2;
  axisOffset: number;
  thicknessDifference: number;
  structuralThickness: number;
  partitionThickness: number;
  aligned: boolean;
}
export interface StructuralConnectionReview {
  connections: StructuralWallConnection[];
  mismatchCount: number;
  warnings: string[];
}
