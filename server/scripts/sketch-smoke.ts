/** Opt-in live multimodal smoke test; uses a synthetic fixture and consumes provider quota. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { workspacesDir } from '../src/config';
import { getAdapter, isValidProvider } from '../src/providers/registry';
import { saveSketch } from '../src/sketch/store';
import { readSketchReport, runSketchTurn } from '../src/sketch/runSketchTurn';

const provider = process.argv[2] ?? 'cursor';
if (!isValidProvider(provider) || provider === 'echo') throw new Error('用法：node --import tsx server/scripts/sketch-smoke.ts cursor|claude');
const cwd = path.join(workspacesDir, `smoke-sketch-${randomUUID()}`);
const bytes = await sharp(new URL('../test/fixtures/sketch-two-room.svg', import.meta.url).pathname).png().toBuffer();
const source = await saveSketch(cwd, 'two-room.png', bytes);
console.log('workspace:', cwd);
const result = await runSketchTurn({ cwd, source, revisionId: 'rev-0001', message: '忠实还原附件草图，尺寸以图上标注为准。' }, getAdapter(provider), (event) => {
  if (event.type === 'progress' || event.type === 'error') console.log(event.message);
}, AbortSignal.timeout(120_000));
const report = readSketchReport(cwd, 'rev-0001');
console.log(JSON.stringify({ failed: result.failed, status: report?.status, walls: report?.model?.walls.length,
  openings: report?.model?.openings.length, labels: report?.extraction?.labels.map((l) => l.text),
  area: report?.model?.spaces.reduce((sum, s) => sum + s.targetArea, 0), issues: report?.issues.map((i) => i.message) }, null, 2));
if (result.failed || !report?.geometryValid || report.model?.openings.length !== 2 || report.extraction?.labels.length !== 2) process.exitCode = 1;
