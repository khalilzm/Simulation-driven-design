import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { repoRoot } from '../config';

export const examplesRouter = Router();

const SUNLIGHT_DEMO_MODEL = path.join(repoRoot, 'examples', 'models', 'sunlight-demo-pass.json');
const SUNLIGHT_DEMO_SCENARIO = path.join(repoRoot, 'examples', 'scenarios', 'sunlight-demo-pass.json');

/** 日照达标演示：约 100㎡ 示例户型 + 夏至客厅 minHours 1h 场景 */
examplesRouter.get('/examples/sunlight-demo-pass', (_req, res) => {
  try {
    const model = JSON.parse(fs.readFileSync(SUNLIGHT_DEMO_MODEL, 'utf8'));
    const sunlight = JSON.parse(fs.readFileSync(SUNLIGHT_DEMO_SCENARIO, 'utf8'));
    res.json({ model, sunlight });
  } catch (err) {
    res.status(500).json({
      error: 'EXAMPLE_LOAD_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
