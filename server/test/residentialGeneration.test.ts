import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createResidentialBrief, createResidentialPreset, type ResidentialBriefDocument } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { interpretResidentialTurn, prepareResidentialGeneration, type ResidentialBriefServices } from '../../web/src/scenarios/residential/generation';
import { attachResidentialDraft, rememberResidentialDraft, type DraftStorage } from '../../web/src/scenarios/residential/draftStorage';
import { resolveResidentialBase } from '../../web/src/scenarios/residential/baseModel';

const source = fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf', import.meta.url), 'utf8');
function inputs() {
  const base = parseFixedEnvelopeDxf(source, 'house.dxf'); base.model.revisionId = 'rev-0001';
  const brief = createResidentialPreset('rev-0001');
  const document: ResidentialBriefDocument = { brief, version: 2, baseModelHash: 'frozen-base', updatedAt: '' };
  return { base, brief, document, draft: { brief, version: 2, dirty: false } };
}
function services(document: ResidentialBriefDocument, overrides: Partial<ResidentialBriefServices> = {}): ResidentialBriefServices {
  return { load: async () => document, save: async (_, brief) => ({ ...document, brief, version: 3 }),
    interpret: async () => ({ brief: document.brief }), saveLocal: () => {}, assertActive: () => {}, ...overrides };
}
function memoryStorage(): DraftStorage {
  const data = new Map<string, string>();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); } };
}

test('residential generation passes a frozen scenario reference instead of draft contents', async () => {
  const { base, document, draft } = inputs();
  const result = await prepareResidentialGeneration('session-a', base, draft, async () => document, () => {});
  assert.deepEqual(result, { mode: 'edit', parentRevisionId: 'rev-0001', scenario: {
    id: 'residential', version: '1', input: { baseRevisionId: 'rev-0001', version: 2, baseModelHash: 'frozen-base' } } });
});

test('unsaved inputs never load a generation reference; changed version or base never dispatches', async () => {
  const { base, document, draft } = inputs(); let calls = 0;
  await assert.rejects(prepareResidentialGeneration('session-a', base, { ...draft, dirty: true }, async () => { calls++; return document; }, () => {}));
  assert.equal(calls, 0);
  for (const changed of [{ ...document, version: 3 }, { ...document, brief: { ...document.brief, baseRevisionId: 'rev-0002' } }])
    await assert.rejects(prepareResidentialGeneration('session-a', base, draft, async () => changed, () => {}), /需求版本已变化/);
});

test('graph interpretation feeds metrics and saves only the final combined requirement', async () => {
  const { base, brief, document } = inputs(); const calls: string[] = [];
  const graph = { ...brief, rooms: [brief.rooms[0]] };
  const result = await interpretResidentialTurn(['graph', 'metrics'], createResidentialBrief('rev-0001'), 2, base, services(document, {
    interpret: async (module, input) => { calls.push(module); if (module === 'metrics') assert.equal(input, graph); return { brief: graph }; },
    load: async () => { calls.push('load'); return document; },
    save: async (_, final) => { calls.push('save'); assert.equal(final, graph); return { ...document, brief: final, version: 3 }; },
  }));
  assert.deepEqual(calls, ['graph', 'metrics', 'load', 'save']);
  assert.deepEqual(result.boards, ['graph', 'metrics']); assert.equal(result.document?.version, 3);
});

test('metrics failure preserves completed graph and reports the actual partial artifacts', async () => {
  const { brief, document } = inputs(); let saved: ResidentialBriefDocument | undefined;
  const result = await interpretResidentialTurn(['graph', 'metrics'], createResidentialBrief('rev-0001'), 2, undefined, services(document, {
    interpret: async module => { if (module === 'metrics') throw new Error('metrics failed'); return { brief }; },
    saveLocal: value => { saved = value; },
  }));
  assert.deepEqual(result.boards, ['graph']); assert.equal(saved?.version, 3); assert.match(result.reply, /metrics failed/);
});

test('empty interpretation creates no board or saved document and skips unattached metrics', async () => {
  const { document } = inputs(); let calls = 0;
  const empty = createResidentialBrief('rev-0001');
  const result = await interpretResidentialTurn(['graph', 'metrics'], empty, 0, undefined, services(document, {
    interpret: async module => { assert.equal(module, 'graph'); calls++; return { brief: empty }; },
    saveLocal: () => { assert.fail('empty artifact cannot be saved'); },
  }));
  assert.equal(calls, 1); assert.deepEqual(result.boards, []); assert.equal(result.document, undefined);
});

test('cancellation or selection change during an interpretation prevents later steps and saving', async () => {
  const { brief, document } = inputs(); let active = true; const calls: string[] = [];
  await assert.rejects(interpretResidentialTurn(['graph', 'metrics'], createResidentialBrief('rev-0001'), 2, undefined, services(document, {
    assertActive: () => { if (!active) throw new Error('obsolete'); },
    interpret: async module => { calls.push(module); active = false; return { brief }; },
    saveLocal: () => { assert.fail('obsolete input must not save'); },
  })), /obsolete/);
  assert.deepEqual(calls, ['graph']);
});

test('selection change during document loading prevents the save and the generation dispatch', async () => {
  const { base, brief, document, draft } = inputs(); let active = true;
  const guard = () => { if (!active) throw new Error('obsolete'); };
  const load = async () => { active = false; return document; };
  await assert.rejects(interpretResidentialTurn(['graph'], brief, 2, base, services(document, {
    load, assertActive: guard, save: async () => { assert.fail('stale base must not save'); },
  })), /obsolete/);
  active = true;
  await assert.rejects(prepareResidentialGeneration('session-a', base, draft, load, guard), /obsolete/);
});

test('DXF association preserves the local draft on save failure and newer edits during attachment', async () => {
  const { brief, document, draft } = inputs(); const storage = memoryStorage();
  rememberResidentialDraft(storage, 'session-a', { ...draft, dirty: true });
  const key = 'sdd.residentialBriefDraft:session-a', original = storage.getItem(key);
  await assert.rejects(attachResidentialDraft(storage, 'session-a', 'rev-0002', async () => document, async () => { throw new Error('conflict'); }));
  assert.equal(storage.getItem(key), original);
  await attachResidentialDraft(storage, 'session-a', 'rev-0002', async () => document, async (_, attached) => {
    assert.equal(attached.baseRevisionId, 'rev-0002');
    rememberResidentialDraft(storage, 'session-a', { brief: { ...brief, rooms: brief.rooms.map(room => ({ ...room, name: room.name + '已编辑' })) }, version: 3, dirty: true });
    return { ...document, brief: attached };
  });
  assert.notEqual(storage.getItem(key), original);
  await attachResidentialDraft(storage, 'session-a', 'rev-0002', async () => document, async (_, attached) => ({ ...document, brief: attached }));
  assert.equal(storage.getItem(key), null);
});

test('switching candidates resolves the referenced base and rejects a mismatched load', async () => {
  const { base } = inputs(); const other = structuredClone(base); other.model.revisionId = 'rev-0002';
  const candidate = structuredClone(base); candidate.model.residentialBrief = { baseRevisionId: 'rev-0002', version: 2, status: 'pending_simulation' };
  let loads = 0;
  assert.equal(await resolveResidentialBase(candidate, base, async revision => { assert.equal(revision, 'rev-0002'); loads++; return other; }), other);
  assert.equal(await resolveResidentialBase(candidate, other, async () => { assert.fail('matching base already loaded'); }), other);
  assert.equal(loads, 1);
  await assert.rejects(resolveResidentialBase(candidate, base, async () => base), /底图版本不匹配/);
});

test('interpretation refuses newer requirements but merges newer diagram layout when semantics stay current', async () => {
  const { base, brief, document } = inputs(); let saves = 0;
  await assert.rejects(interpretResidentialTurn(['graph'], brief, 2, base, services(document, {
    load: async () => ({ ...document, version: 3 }), save: async () => { saves++; return document; },
  }), document), /需求版本已变化/);
  assert.equal(saves, 0);
  const latest = structuredClone(document); latest.graphLayoutVersion = 4;
  latest.brief.rooms[0].position = { x: .13, y: .82 };
  const interpreted = structuredClone(brief); interpreted.rooms[0].name = '新房间名称';
  const result = await interpretResidentialTurn(['graph'], brief, 2, base, services(document, {
    interpret: async () => ({ brief: interpreted }), load: async () => latest,
    save: async (current, next) => {
      assert.equal(current.graphLayoutVersion, 4); assert.deepEqual(next.rooms[0].position, latest.brief.rooms[0].position);
      return { ...current, brief: next, version: 3 };
    },
  }), { ...document, graphLayoutVersion: 3 });
  assert.equal(result.document?.brief.rooms[0].name, '新房间名称');
});
