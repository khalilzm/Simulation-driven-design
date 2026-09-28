import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vec2 } from '@sdd/shared';
import { snapExteriorBoundarySegments } from '../src/design/layoutBoundarySnap';
import { validateExplicitBoundaries } from '../src/design/parseLayoutPlanV2';
import { compileLayoutPlan } from '../src/design/compileLayoutPlan';
import { createLayoutContext } from '../src/design/layoutContext';
import { buildOutlineJson } from '../src/spacePrompt';

const OCT: Vec2[] = [
  [2.929, 0],
  [7.071, 0],
  [10, 2.929],
  [10, 7.071],
  [7.071, 10],
  [2.929, 10],
  [0, 7.071],
  [0, 2.929],
];

test('snapExteriorBoundarySegments 修正偏离底边的窗 segment', () => {
  const floor: Vec2[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
  const space = { id: 'main', usage: '主空间', enclosed: false, boundary: [[0, 0], [10, 0], [10, 8], [0, 8]] as Vec2[] };
  const boundaries = [{
    id: 'win_s',
    segment: [[2, -0.4], [4, -0.4]] as [[number, number], [number, number]],
    kind: 'wall' as const,
    leftSpaceId: 'outside',
    rightSpaceId: 'main',
  }];
  const { boundaries: snapped, notes } = snapExteriorBoundarySegments(boundaries, [space], floor);
  assert.ok(notes.length >= 1);
  const errors = validateExplicitBoundaries([space], snapped, floor);
  assert.equal(errors.length, 0);
});

test('八边形斜边外窗经 compile 前 snap 可通过共享边校验', () => {
  const floorOutline = buildOutlineJson({ boundary: OCT, origin: [0, 0], bbox: { width: 10, height: 10, area: 83 } });
  const catalog = createLayoutContext(floorOutline);
  const badSegment: [[number, number], [number, number]] = [[8.5, 9.2], [9.4, 8.1]];
  const { model, warnings } = compileLayoutPlan({
    schemaVersion: 2,
    spaces: [{ id: 'bed_ne', usage: '卧室', enclosed: false, boundary: OCT }],
    boundaries: [{
      id: 'win_ne_diag',
      segment: badSegment,
      kind: 'wall',
      leftSpaceId: 'outside',
      rightSpaceId: 'bed_ne',
    }],
    openings: [],
    doors: [],
    windows: [],
    assumptions: [],
    unmetRequirements: [],
  }, catalog, 'rev-snap', false);
  assert.ok(warnings.some((w) => w.includes('snap')));
  assert.ok(model.walls.length > 0);
});
