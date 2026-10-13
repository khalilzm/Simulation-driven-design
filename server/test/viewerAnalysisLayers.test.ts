import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DaylightResult, PedestrianResult, SunlightResult } from '@sdd/shared';
import type { ViewerModelContent } from '../../web/src/types';
import { ANALYSIS_LAYERS, analysisLayerForView, registeredAnalysisLayers } from '../../web/src/viewer/analysisLayers';
import { daylightGridsToFills, sunlightGridsToFills } from '../../web/src/viewer/sunlightMeshRender';
import { pedestrianDensityToFills } from '../../web/src/viewer/pedestrianMeshRender';
import { trajectoriesToLineGroups } from '../../web/src/viewer/pedestrianTrajectories';
import { sampleModel } from './fixtures/sampleModel';

function content(): ViewerModelContent {
  const daylight: DaylightResult = { schemaVersion: '1', status: 'completed', engineVersion: 'daylight-test',
    method: 'overcast-daylight-factor', outdoorIlluminanceLux: 10000, spaces: [], assumptions: [],
    grids: [{ gridId: 'lux', spaceId: 'room-main', vertices: [[0,0,.75],[1,0,.75],[0,1,.75]], faces: [[0,1,2]], lux: [500], daylightFactors: [5] }] };
  const sunlight: SunlightResult = { schemaVersion: '1', status: 'completed', engineVersion: 'sun-test',
    metrics: { unit: 'hour', sensorCount: 1, targetAreaRatio: null }, spaces: [], verification: { status: 'needs_review', checks: [] },
    grids: [{ gridId: 'hours', spaceId: 'room-main', vertices: [[0,0,.75],[1,0,.75],[0,1,.75]], faces: [[0,1,2]], hours: [1] }] };
  const pedestrian: PedestrianResult = { schemaVersion: '1', status: 'completed', scenario: 'egress', engineVersion: 'ped-test',
    metrics: { unit: 'second', totalAgents: 1, egressTimeSec: 2, meanEgressTimeSec: 2, peakDoorDensity: [], bottleneckSpaceIds: [] },
    verification: { status: 'needs_review', checks: [] },
    densityGrid: { gridId: 'density', vertices: [[0,0],[1,0],[0,1]], faces: [[0,1,2]], density: [1] },
    trajectories: [{ agentId: 1, spaceId: 'room-main', times: [0,2], points: [[0,0],[1,1]] }] };
  return { kind: 'model', model: structuredClone(sampleModel), daylight, sunlight, pedestrian };
}

test('daylight and direct sun are separately selected and do not borrow each other’s values', () => {
  const data = content();
  const lux = analysisLayerForView('daylight')!, hours = analysisLayerForView('sunlight')!;
  assert.equal(lux.unit, 'lx'); assert.equal(hours.unit, 'h'); assert.notEqual(lux.label, hours.label);
  assert.deepEqual(lux.geometry(data).fills, daylightGridsToFills(data.daylight!));
  assert.deepEqual(hours.geometry(data).fills, sunlightGridsToFills(data.sunlight!));
  assert.notEqual(lux.geometry(data).fills[0].color, hours.geometry(data).fills[0].color);
  assert.equal(data.daylight!.grids[0].lux[0], 500); assert.equal(data.sunlight!.grids![0].hours[0], 1);
});

test('residential metadata cannot suppress direct sun or change a selected result', () => {
  const generic = content(), residential = structuredClone(generic);
  residential.model.model.residentialBrief = { baseRevisionId: 'rev-0001', version: 1, status: 'pending_simulation' };
  for (const layer of registeredAnalysisLayers()) {
    assert.ok(layer.isCompleted(residential));
    assert.deepEqual(layer.geometry(residential), layer.geometry(generic));
  }
});

test('completed daylight can be viewed without residential metadata', () => {
  const data = content(); delete data.model.model.residentialBrief; delete data.sunlight;
  assert.ok(ANALYSIS_LAYERS.daylight.isCompleted(data));
  assert.equal(ANALYSIS_LAYERS.daylight.geometry(data).fills.length, 1);
  assert.equal(ANALYSIS_LAYERS.sunlight.isCompleted(data), false);
  assert.deepEqual(ANALYSIS_LAYERS.sunlight.geometry(data), { fills: [], lines: [] });
});

test('missing and failed results create no analysis geometry or playback, even beside completed capabilities', () => {
  for (const layer of registeredAnalysisLayers()) {
    const data = content();
    data[layer.id]!.status = 'failed';
    assert.equal(layer.isCompleted(data), false); assert.deepEqual(layer.geometry(data), { fills: [], lines: [] });
    delete data[layer.id];
    assert.equal(layer.isCompleted(data), false); assert.deepEqual(layer.geometry(data), { fills: [], lines: [] });
  }
});

test('comparison scales and common playback duration reach capability render adapters without modifying results', () => {
  const data = content(), before = structuredClone(data);
  data.comparison = { sunlightScale: { min: 0, max: 8, colors: [{r:0,g:0,b:0},{r:255,g:255,b:255}] },
    densityScale: { min: 0, max: 5, colors: [{r:0,g:0,b:255},{r:255,g:0,b:0}] }, pedestrianTimeMax: 10 };
  assert.deepEqual(ANALYSIS_LAYERS.sunlight.geometry(data).fills, sunlightGridsToFills(data.sunlight!, data.comparison.sunlightScale));
  assert.deepEqual(ANALYSIS_LAYERS.pedestrian.geometry(data).fills, pedestrianDensityToFills(data.pedestrian!, data.comparison.densityScale));
  assert.deepEqual(ANALYSIS_LAYERS.pedestrian.geometry(data).lines, trajectoriesToLineGroups(data.pedestrian!, 10));
  assert.deepEqual(data.sunlight, before.sunlight); assert.deepEqual(data.pedestrian, before.pedestrian);
});

test('only registered analysis views expose adapters and only pedestrians expose playback data', () => {
  const data = content();
  assert.deepEqual(registeredAnalysisLayers().map(layer => layer.id), ['daylight', 'sunlight', 'pedestrian']);
  assert.equal(analysisLayerForView('usage'), undefined); assert.equal(analysisLayerForView('3d'), undefined);
  assert.equal(ANALYSIS_LAYERS.daylight.geometry(data).playback, undefined);
  assert.equal(ANALYSIS_LAYERS.sunlight.geometry(data).playback, undefined);
  assert.equal(ANALYSIS_LAYERS.pedestrian.geometry(data).playback, data.pedestrian);
});
