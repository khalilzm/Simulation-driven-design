import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SpaceModel } from '@sdd/shared';
import { defaultAgents, ensurePedestrianConfig } from '../src/pedestrian/ensureConfig';

function space(id: string, targetArea: number, enclosed?: boolean): SpaceModel['spaces'][number] {
  return {
    id, boundary: [[0, 0], [1, 0], [1, 1], [0, 1]],
    typeId: 't', usage: id, targetArea, performancePreferences: {},
    ...(enclosed !== undefined ? { enclosed } : {}),
  };
}

function model(spaces: SpaceModel['spaces']): SpaceModel {
  return { spaces } as unknown as SpaceModel;
}

test('defaultAgents 按面积折算并排除开放交通区', () => {
  const agents = defaultAgents(model([space('office', 80), space('meeting', 40), space('corridor', 20, false)]));
  assert.deepEqual(agents.map((a) => a.spaceId).sort(), ['meeting', 'office']);
  assert.equal(agents.find((a) => a.spaceId === 'office')!.count, 10);
  assert.equal(agents.find((a) => a.spaceId === 'meeting')!.count, 5);
});

test('ensurePedestrianConfig 创建默认疏散配置且幂等', () => {
  const dir = path.join('/tmp', `sdd-ped-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'pedestrian.json');
  const first = ensurePedestrianConfig(configPath, model([space('office', 80)]));
  assert.equal(first.created, true);
  assert.ok(fs.existsSync(configPath));
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(parsed.scenario, 'egress');
  assert.deepEqual(parsed.agents, [{ spaceId: 'office', count: 10 }]);
  const second = ensurePedestrianConfig(configPath, model([space('office', 80)]));
  assert.equal(second.created, false);
  fs.rmSync(dir, { recursive: true, force: true });
});
