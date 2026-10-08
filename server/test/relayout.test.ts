import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDesignIntent } from '../src/design/intent';
import { createLayoutContext } from '../src/design/layoutContext';
import { compileIntent } from '../src/design/layoutIntent';
import { compileRelayoutModel, proposeRelayoutIntent, runRelayoutOptimization } from '../src/optimization/relayout';
import type { ProviderAdapter } from '../src/providers/types';
import { evaluation, optimizationPedestrian, optimizationSunlight } from './helpers/optimization';

function outline(width: number, height: number): string {
  return JSON.stringify({ boundary: [[0, 0], [width, 0], [width, height], [0, height], [0, 0]], origin: [0, 0], units: 'm' });
}

const baseIntent = {
  schemaVersion: 1,
  rooms: [
    { id: 'living', usage: '客厅', area: { min: 20, target: 30 }, privacy: 'public' },
    { id: 'bed', usage: '卧室', area: { min: 10, target: 15 } },
  ],
  adjacencies: [{ a: 'living', b: 'bed', relation: 'adjacent' }],
  doors: [{ connects: ['living', 'bed'], width: 0.9, height: 2.1 }],
  daylight: [{ roomIds: ['living'], minHours: 3 }],
  assumptions: [],
  unmetRequirements: [],
};

const rearrangedIntent = {
  schemaVersion: 1,
  rooms: [
    { id: 'living', usage: '客厅', area: { min: 20, target: 30 }, privacy: 'public' },
    { id: 'bed', usage: '卧室', area: { min: 10, target: 15 } },
  ],
  adjacencies: [{ a: 'living', b: 'bed', relation: 'adjacent' }],
  doors: [{ connects: ['living', 'bed'], width: 0.9, height: 2.1 }],
  daylight: [{ roomIds: ['bed'], minHours: 3 }],
  assumptions: [],
  unmetRequirements: [],
};

test('compileRelayoutModel 用新意图重排内部布局并保留外轮廓', () => {
  const baseParsed = parseDesignIntent(baseIntent);
  assert.equal(baseParsed.ok, true);
  if (!baseParsed.ok) return;
  const baseline = compileIntent(baseParsed.intent, createLayoutContext(outline(10, 8)), 'rev-base').model;

  const rearParsed = parseDesignIntent(rearrangedIntent);
  assert.equal(rearParsed.ok, true);
  if (!rearParsed.ok) return;
  const relaid = compileRelayoutModel(baseline, rearParsed.intent, 'rev-relayout');

  assert.deepEqual(relaid.floor.boundary, baseline.floor.boundary, '外轮廓保留');
  assert.deepEqual(relaid.spaces.map((s) => s.id).sort(), ['bed', 'living']);
  assert.equal(relaid.model.revisionId, 'rev-relayout');
  assert.ok(relaid.doors.length >= 1);
  assert.ok(relaid.walls.length >= 4);
});

test('runRelayoutOptimization 提意图→编译→复算→比较→推荐', async () => {
  const baseParsed = parseDesignIntent(baseIntent);
  assert.equal(baseParsed.ok, true);
  if (!baseParsed.ok) return;
  const baseline = compileIntent(baseParsed.intent, createLayoutContext(outline(10, 8)), 'rev-base').model;

  const rearParsed = parseDesignIntent(rearrangedIntent);
  assert.equal(rearParsed.ok, true);
  if (!rearParsed.ok) return;

  let call = 0;
  const evaluate = async (m: unknown, ctx: { scenarioHash: string }) => {
    const duration = call++ === 0 ? 20 : 18;
    return { ...evaluation(duration), scenarioHash: ctx.scenarioHash };
  };

  const result = await runRelayoutOptimization(
    { sessionId: 's', baseRevisionId: 'rev-base', scenarioHash: 'scenario', configs: { sunlight: optimizationSunlight, pedestrian: optimizationPedestrian } },
    baseline,
    async () => ({ summary: '重排', intents: [rearParsed.intent] }),
    new AbortController().signal,
    () => {},
    evaluate,
  );

  assert.equal(result.baseline.pedestrian.egressTimeSec, 20);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].assessment.improved, true);
  assert.equal(result.recommendedId, 'relayout-1');
});

test('proposeRelayoutIntent 让 Agent 写意图并解析校验', async () => {
  const baseParsed = parseDesignIntent(baseIntent);
  assert.equal(baseParsed.ok, true);
  if (!baseParsed.ok) return;
  const baseline = compileIntent(baseParsed.intent, createLayoutContext(outline(10, 8)), 'rev-base').model;

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relayout-'));
  const adapter: ProviderAdapter = { id: 'fixture', async run(input) {
    const dir = path.join(input.cwd, 'designs', 'rev-base');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'intent.json'), JSON.stringify(rearrangedIntent));
    return { failed: false };
  } };
  const { intents } = await proposeRelayoutIntent(adapter, baseline, cwd, 'rev-base', '重排', new AbortController().signal);
  assert.equal(intents.length, 1);
  assert.deepEqual(intents[0].rooms.map((r) => r.id).sort(), ['bed', 'living']);
  fs.rmSync(cwd, { recursive: true, force: true });
});
