import type { SketchExtraction, SketchSource } from '@sdd/shared';

export const sketchSource: SketchSource = {
  id: 'sketch-11111111-1111-1111-1111-111111111111', originalName: '住宅草图.png',
  originalPath: 'inputs/original.png', imagePath: 'inputs/test.png', sha256: 'test',
  width: 1000, height: 800, createdAt: '2026-09-30T00:00:00.000Z',
};

export function sketchFixture(): SketchExtraction {
  return {
    schemaVersion: 1, sketchId: sketchSource.id, coordinateSystem: 'image-pixels',
    walls: [
      { id: 'W1', points: [[100, 100], [900, 100]], thicknessPx: 20 },
      { id: 'W2', points: [[900, 100], [900, 700]], thicknessPx: 20 },
      { id: 'W3', points: [[900, 700], [100, 700]], thicknessPx: 20 },
      { id: 'W4', points: [[100, 700], [100, 100]], thicknessPx: 20 },
      { id: 'W5', points: [[500, 100], [500, 700]], thicknessPx: 20 },
    ],
    openings: [
      { id: 'D1', kind: 'door', wallId: 'W5', position: 0.5, widthPx: 90, heightM: 2.1, sillHeightM: 0, hinge: 'start', opensTo: 'right', leafCount: 1 },
      { id: 'N1', kind: 'window', wallId: 'W1', position: 0.2, widthPx: 120, heightM: 1.2, sillHeightM: 0.9, hinge: null, opensTo: null, leafCount: null },
    ],
    labels: [{ id: 'L1', text: '客厅', usage: '客厅', kind: 'function', point: [300, 400] }, { id: 'L2', text: '主卧', usage: '卧室', kind: 'function', point: [700, 400] }],
    dimensions: [{ id: 'M1', points: [[100, 100], [900, 100]], lengthM: 8, text: '8m' }],
    heightM: 3, dividers: [], uncertainties: [],
  };
}
