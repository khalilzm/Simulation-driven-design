import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { briefDaylightConfig, createResidentialPreset, nextResidentialBriefDocument, residentialBriefChanges,
  residentialBriefSemantics, residentialGraphLayout, type ResidentialBriefDocument, type StoredResidentialBriefDocument } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { saveDesign } from '../src/model/store';
import { workspacesDir } from '../src/config';
import { briefBaseHash, loadResidentialBrief, prepareResidentialGeneration, residentialGenerationMessage, saveResidentialBrief } from '../src/scenarios/residential/residentialBrief';
import { residentialEvaluationIdentity } from '../src/scenarios/residential/evaluationIdentity';
import { sameCachedResult } from '../src/analysis/runtime/identity';

const source = fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf', import.meta.url), 'utf8');
function setup(t: TestContext) {
  const sessionId = `test-layout-${randomUUID()}`;
  t.after(() => fs.rmSync(path.join(workspacesDir, sessionId), { recursive: true, force: true }));
  const { revisionId } = saveDesign(sessionId, parseFixedEnvelopeDxf(source, 'house.dxf'));
  const initial = loadResidentialBrief(sessionId, revisionId);
  const file = path.join(workspacesDir, sessionId, 'designs', revisionId, 'residential-brief.json');
  const save = (previous: ResidentialBriefDocument, brief = previous.brief) => saveResidentialBrief(sessionId, revisionId,
    { brief, expectedVersion: previous.version, expectedGraphLayoutVersion: previous.graphLayoutVersion ?? 0, baseModelHash: previous.baseModelHash });
  return { sessionId, revisionId, file, model: initial.model, initial: initial.document, save };
}
function moved(document: ResidentialBriefDocument) {
  const brief = structuredClone(document.brief);
  brief.rooms[0].position = { x: .12, y: .93 };
  brief.relations[0].diagramHandles = { from: 'left', to: 'right' };
  return brief;
}

test('layout saves keep semantic version, generation admission, frozen history and cache identity', t => {
  const { sessionId, revisionId, file, model, initial, save } = setup(t);
  const published = save(initial);
  const history = path.join(path.dirname(file), 'generation-brief.json');
  fs.writeFileSync(history, JSON.stringify(published)); const frozen = fs.readFileSync(history, 'utf8');
  const before = residentialEvaluationIdentity(sessionId, revisionId, model, published, 'daylight', briefDaylightConfig(published.brief), 'test-engine');
  const layout = save(published, moved(published));
  assert.equal(layout.version, published.version); assert.equal(layout.updatedAt, published.updatedAt);
  assert.equal(layout.graphLayoutVersion, published.graphLayoutVersion! + 1);
  assert.deepEqual(loadResidentialBrief(sessionId, revisionId).document, layout);
  assert.equal(prepareResidentialGeneration(sessionId, { baseRevisionId: revisionId, version: published.version, baseModelHash: published.baseModelHash }).document.version, published.version);
  assert.equal(fs.readFileSync(history, 'utf8'), frozen);
  assert.ok(sameCachedResult(residentialEvaluationIdentity(sessionId, revisionId, model, layout, 'daylight', briefDaylightConfig(layout.brief), 'test-engine'), before));
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredResidentialBriefDocument;
  assert.equal(stored.schemaVersion, '2'); assert.ok(!('position' in stored.semanticBrief.rooms[0]));
  assert.ok(!('diagramHandles' in stored.semanticBrief.relations[0]));
  assert.deepEqual(stored.graphLayout.data.positions[layout.brief.rooms[0].id], { x: .12, y: .93 });
});

test('actual room, relation and simulation changes advance semantic version and invalidate identities', t => {
  const { sessionId, revisionId, model, initial, save } = setup(t);
  const published = save(initial);
  for (const edit of [
    (brief: typeof published.brief) => { brief.rooms[0].area.target += 1; },
    (brief: typeof published.brief) => { brief.relations[0].priority = 'soft'; },
    (brief: typeof published.brief) => { brief.daylight!.outdoorIlluminanceLux += 100; },
  ]) {
    const current = loadResidentialBrief(sessionId, revisionId).document;
    const brief = structuredClone(current.brief); edit(brief); const next = save(current, brief);
    assert.equal(next.version, current.version + 1); assert.equal(next.graphLayoutVersion, current.graphLayoutVersion);
    assert.ok(!sameCachedResult(residentialEvaluationIdentity(sessionId, revisionId, model, next, 'daylight', briefDaylightConfig(next.brief), 'test-engine'),
      residentialEvaluationIdentity(sessionId, revisionId, model, current, 'daylight', briefDaylightConfig(current.brief), 'test-engine')));
  }
});

test('concurrent diagram writes and legacy layout overwrites are rejected without modifying the file', t => {
  const { sessionId, revisionId, initial, save, file } = setup(t);
  const published = save(initial), layout = save(published, moved(published));
  const bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => save(published), /排版已变化/);
  assert.throws(() => saveResidentialBrief(sessionId, revisionId, { brief: published.brief, expectedVersion: layout.version, baseModelHash: layout.baseModelHash }), /排版已变化/);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('legacy inline documents read without mutation and migrate on save without advancing semantics', t => {
  const { file, sessionId, revisionId, model, save } = setup(t);
  const legacy: ResidentialBriefDocument = { brief: createResidentialPreset(revisionId), version: 7, updatedAt: 'old', baseModelHash: briefBaseHash(model) };
  legacy.brief.rooms[0].position = { x: .1, y: .8 };
  fs.writeFileSync(file, JSON.stringify(legacy)); const original = fs.readFileSync(file, 'utf8');
  assert.deepEqual(loadResidentialBrief(sessionId, revisionId).document, legacy);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const migrated = save(legacy);
  assert.equal(migrated.version, 7); assert.equal(migrated.updatedAt, 'old');
  assert.deepEqual(migrated.brief, legacy.brief); assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, '2');
});

test('local drafts distinguish first publication, layout edits and no-op saves', () => {
  const initial: ResidentialBriefDocument = { brief: createResidentialPreset('rev-1'), version: 0, updatedAt: '', baseModelHash: '' };
  const first = nextResidentialBriefDocument(initial, initial.brief, 'first');
  assert.equal(first.version, 1); assert.equal(first.graphLayoutVersion, 1);
  const layout = nextResidentialBriefDocument(first, moved(first), 'layout');
  assert.equal(layout.version, 1); assert.equal(layout.updatedAt, 'first'); assert.equal(layout.graphLayoutUpdatedAt, 'layout');
  assert.deepEqual(residentialBriefChanges(first.brief, layout.brief), { semantic: false, layout: true });
  assert.deepEqual(nextResidentialBriefDocument(layout, layout.brief, 'noop'), layout);
  assert.deepEqual(residentialBriefSemantics(first.brief), residentialBriefSemantics(layout.brief));
  assert.notDeepEqual(residentialGraphLayout(first.brief), residentialGraphLayout(layout.brief));
});

test('agent generation input is unchanged by layout coordinates and connection handles', () => {
  const original: ResidentialBriefDocument = { brief: createResidentialPreset('rev-1'), version: 1, updatedAt: '', baseModelHash: '' };
  assert.equal(residentialGenerationMessage(original), residentialGenerationMessage({ ...original, brief: moved(original), graphLayoutVersion: 9 }));
});
