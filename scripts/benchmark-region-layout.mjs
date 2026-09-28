import { performance } from 'node:perf_hooks';
import { createLayoutContext } from '../server/src/design/layoutContext.ts';
import { compileLayout } from '../server/src/design/compileLayout.ts';

const boundary = [[0, 0], [12, 0], [12, 9], [0, 9], [0, 0]];

const plan = {
  schemaVersion: 2,
  spaces: [
    { id: 'a', usage: 'A', enclosed: false, boundary: [[0, 0], [6, 0], [6, 9], [0, 9]] },
    { id: 'b', usage: 'B', enclosed: true, boundary: [[6, 0], [12, 0], [12, 9], [6, 9]] },
  ],
  boundaries: [{ id: 'split', segment: [[6, 0], [6, 9]], kind: 'wall', leftSpaceId: 'a', rightSpaceId: 'b' }],
  openings: [],
  doors: [],
  windows: [],
  assumptions: [],
  unmetRequirements: [],
};

const ctx = createLayoutContext(JSON.stringify({ boundary, origin: [0, 0] }));
const start = performance.now();
for (let i = 0; i < 500; i++) compileLayout(plan, ctx, 'rev-0001', true);
console.log(`v2 compile x500: ${(performance.now() - start).toFixed(1)} ms`);
