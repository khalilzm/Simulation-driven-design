import type { OptimizationEvaluation, OptimizationRequest, SpaceModel, SunlightConfig, PedestrianConfig } from '@sdd/shared';
import { layoutModel, rectangle } from './spaceModel';
import { optimizationResultIdentity } from '../../src/optimization/resultIdentity';
import { sunlightEngineId, pedestrianEngineId } from '../../src/config';

export function optimizationModel(): SpaceModel {
  const model = layoutModel();
  model.floor = { boundary: rectangle(0, 0, 20, 10), height: 3, elevation: 0, topObstruction: true, bottomObstruction: true };
  model.model.origin = [0, 0];
  model.spaceTypes = [{ id: 'room', label: '活动室', color: '#A8C8F0' }];
  model.spaces = [
    { id: 'roomA', allocationId: 'roomA', typeId: 'room', usage: '活动室 A', boundary: rectangle(0.1, 0.1, 9.9, 9.9),
      targetArea: 96.04, enclosed: true, performancePreferences: {} },
    { id: 'roomB', allocationId: 'roomB', typeId: 'room', usage: '活动室 B', boundary: rectangle(10.1, 0.1, 19.9, 9.9),
      targetArea: 96.04, enclosed: true, performancePreferences: {} },
  ];
  model.walls = model.floor.boundary.slice(0, -1).map((point, i) => ({
    id: `outer-${i}`, geometry: { type: 'polyline', points: [point, model.floor.boundary[i + 1]] },
    height: 3, thickness: 0.2, fixed: true,
  }));
  model.walls.push({ id: 'partition', geometry: { type: 'polyline', points: [[10, 0], [10, 10]] },
    height: 3, thickness: 0.2, fixed: false, role: 'partition' });
  model.openings = [
    { id: 'inside', hostWallId: 'partition', position: 5, width: 0.8, height: 2.1, sillHeight: 0 },
    { id: 'exit', hostWallId: 'outer-0', position: 5, width: 2, height: 2.1, sillHeight: 0 },
    { id: 'windowA', hostWallId: 'outer-0', position: 2, width: 2, height: 1.4, sillHeight: 0.8 },
    { id: 'windowB', hostWallId: 'outer-0', position: 15, width: 2, height: 1.4, sillHeight: 0.8 },
  ];
  model.doors = ['inside', 'exit'].map((openingId) => ({ id: `door-${openingId}`, openingId,
    swing: 'none', analysisProperties: {} }));
  model.windows = ['windowA', 'windowB'].map((openingId) => ({ id: `fill-${openingId}`, openingId, analysisProperties: {} }));
  return model;
}

export const optimizationSunlight: SunlightConfig = { schemaVersion: '1',
  location: { latitude: 31.23, longitude: 121.47, timezone: 'Asia/Shanghai' },
  analysisDate: '2026-06-21', localTimeRange: ['10:00', '14:00'], northDegrees: 0, timestepMinutes: 60,
  sensors: { gridSpacing: 2, referenceHeightAboveFloor: 0.75 } };
export const optimizationPedestrian: PedestrianConfig = { schemaVersion: '1', scenario: 'egress',
  model: 'collision-free', dt: 0.05, maxDurationSec: 120, seed: 1,
  agents: [{ spaceId: 'roomA', count: 10 }, { spaceId: 'roomB', count: 20 }] };

export function optimizationRequest(sessionId: string): OptimizationRequest {
  return { sessionId, revisionId: 'rev-0001', provider: 'cursor', openingId: 'inside',
    expectedWidthM: 0.8, maxWidthM: 1.4, confirmEditable: true,
    message: '仅增宽指定内门以改善疏散，保持日照，比较小幅和较大增宽。' };
}

export function evaluation(duration = 20): OptimizationEvaluation {
  return { identity: optimizationResultIdentity(optimizationModel(), {sessionId:'test',baseRevisionId:'rev-0001',configs:{sunlight:optimizationSunlight,pedestrian:optimizationPedestrian}}),
    scenarioHash: 'scenario', sunlight: { taskId: 'sun', inputHash: 'sun-hash', engineVersion: sunlightEngineId,
    targetAreaRatio: 0.5, spaces: ['roomA', 'roomB'].map((spaceId) => ({
      spaceId, sensorCount: 25, sampledArea: 100, meanHours: 1, minHours: 0, maxHours: 2, targetMetRatio: 0.5,
    })) }, pedestrian: { taskId: 'ped', inputHash: 'ped-hash', engineVersion: pedestrianEngineId, totalAgents: 30, egressTimeSec: duration } };
}
