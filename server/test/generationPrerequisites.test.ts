import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { createResidentialPreset, generationPrerequisites } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { handleSpaceTurn } from '../src/routes/spaceTurn';

const fixture = fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf', import.meta.url), 'utf8');

test('workbench requires a matching DXF, saved nodes and enabled simulation targets', () => {
  const base = parseFixedEnvelopeDxf(fixture, 'house.dxf');
  base.model.revisionId = 'rev-0001';
  const brief = createResidentialPreset('rev-0001', base.doors[0]?.id);
  assert.deepEqual(generationPrerequisites(base, brief, 1), []);
  assert.ok(generationPrerequisites().some(item => item.includes('DXF')));
  assert.ok(generationPrerequisites(base, brief, 0).some(item => item.includes('保存')));
  assert.ok(generationPrerequisites(base, brief, 1, true).some(item => item.includes('保存')));
  assert.ok(generationPrerequisites(base, { ...brief, baseRevisionId: 'rev-9999' }, 1).some(item => item.includes('节点')));
  assert.ok(generationPrerequisites(base, { ...brief, rooms: [] }, 1).some(item => item.includes('节点')));
  const noTargets = structuredClone(brief);
  noTargets.rooms.forEach(room => { room.daylight!.enabled = false; });
  assert.ok(generationPrerequisites(base, noTargets, 1).some(item => item.includes('仿真指标')));
});

test('workbench chat and generate cannot call Agent without frozen inputs', async () => {
  for (const generate of [false, true]) {
    let status = 200;
    let body: { error?: string } = {};
    const req = { body: { provider: 'echo', sessionId: 'test-unprepared-workbench', mode: 'generate', message: '生成方案', requirePreparedInputs: true } } as Request;
    const res = Object.assign(new EventEmitter(), { status(code: number) { status = code; return this; }, json(value: typeof body) { body = value; return this; } }) as unknown as Response;
    await handleSpaceTurn(req, res, generate);
    assert.equal(status, 400);
    assert.match(body.error!, /底图.*空间节点.*仿真指标/);
  }
});
