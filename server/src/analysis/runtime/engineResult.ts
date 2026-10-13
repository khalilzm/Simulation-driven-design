import type { EngineCapability, EngineResultByCapability, EngineTaskErrorCode } from '@sdd/shared';

export class EngineResultError extends Error {
  constructor(message: string, public readonly code: EngineTaskErrorCode = 'invalid_result') {
    super(message); this.name = 'EngineResultError';
  }
}
const fail = (field: string): never => { throw new EngineResultError(`引擎结果字段无效或缺失：${field}`); };
const object = (value: unknown, field: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail(field);
const array = (value: unknown, field: string): unknown[] => Array.isArray(value) ? value : fail(field);
const string = (value: unknown, field: string) => { if (typeof value !== 'string' || !value.trim()) fail(field); };
const number = (value: unknown, field: string, nonnegative = true) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (nonnegative && value < 0)) fail(field);
};
const integer = (value: unknown, field: string) => { number(value, field); if (!Number.isSafeInteger(value)) fail(field); };
const ratio = (value: unknown, field: string) => { if (value !== null) { number(value, field); if ((value as number) > 1) fail(field); } };
const nullableNumber = (value: unknown, field: string) => { if (value !== null) number(value, field); };
const strings = (value: unknown, field: string) => { for (const item of array(value, field)) if (typeof item !== 'string') fail(field); };
function finiteJson(value: unknown) {
  if (typeof value === 'number' && !Number.isFinite(value)) fail('非有限数值');
  if (Array.isArray(value)) value.forEach(finiteJson);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteJson);
}
function verification(value: unknown) {
  const check = object(value, 'verification');
  if (!['passed', 'failed', 'needs_review'].includes(String(check.status))) fail('verification.status');
  strings(check.checks, 'verification.checks');
}
function grid(value: unknown, dimension: number, valuesKey: string) {
  const mesh = object(value, 'grid'); string(mesh.gridId, 'gridId');
  const vertices = array(mesh.vertices, 'vertices'), faces = array(mesh.faces, 'faces');
  for (const vertex of vertices) {
    const coordinates = array(vertex, 'vertex'); if (coordinates.length !== dimension) fail('vertex dimension');
    coordinates.forEach(n => number(n, 'vertex coordinate', false));
  }
  for (const face of faces) {
    const indices = array(face, 'face'); if (indices.length < 3) fail('face');
    for (const index of indices) { integer(index, 'face index'); if ((index as number) >= vertices.length) fail('face index'); }
  }
  const values = array(mesh[valuesKey], valuesKey);
  if (values.length !== faces.length) fail(`${valuesKey} count`);
  values.forEach(n => number(n, valuesKey));
  return mesh;
}
function spatialRows(value: unknown, daylight: boolean) {
  const seen = new Set<unknown>();
  for (const raw of array(value, 'spaces')) {
    const row = object(raw, 'space'); string(row.spaceId, 'spaceId');
    if (seen.has(row.spaceId)) fail('duplicate spaceId'); seen.add(row.spaceId);
    integer(row.sensorCount, 'sensorCount'); ratio(row.targetMetRatio, 'targetMetRatio');
    if (daylight) {
      string(row.allocationId, 'allocationId');
      for (const key of ['sampledArea', 'meanLux', 'minLux', 'maxLux', 'meanDaylightFactor']) number(row[key], key);
    } else {
      for (const key of ['meanHours', 'minHours', 'maxHours']) number(row[key], key);
      if (row.sampledArea !== undefined) number(row.sampledArea, 'sampledArea');
    }
  }
}

function sampling(value: unknown, daylight: boolean) {
  const sample = object(value, 'sampling');
  if (!['converged', 'needs_review'].includes(String(sample.status))) fail('sampling.status');
  if (daylight) { number(sample.baseSpacing, 'baseSpacing'); number(sample.refinedSpacing, 'refinedSpacing'); }
  else {
    string(sample.method, 'sampling.method');
    for (const key of ['baseGridSpacing', 'baseFineStep', 'refinedFineStep', 'ratioTolerance', 'meanHoursTolerance'])
      if (sample[key] !== undefined) number(sample[key], key);
  }
  for (const rawRoom of array(sample.rooms, 'sampling.rooms')) {
    const room = object(rawRoom, 'sampling room'); string(room.allocationId, 'sampling.allocationId');
    if (!['converged', 'needs_review'].includes(String(room.status))) fail('sampling room status');
    if (room.reason !== undefined && room.reason !== null && typeof room.reason !== 'string') fail('sampling reason');
    if (daylight) number(room.meanLuxDelta, 'meanLuxDelta');
    for (const key of ['baseTargetRatio', 'refinedTargetRatio']) if (daylight || room[key] !== undefined) ratio(room[key], key);
    for (const key of ['targetRatioDelta', 'meanHoursDelta', 'positiveAreaRatioDelta'])
      if ((daylight && key === 'targetRatioDelta') || room[key] !== undefined) nullableNumber(room[key], key);
  }
}
function optionalSunlightDetails(result: Record<string, unknown>) {
  if (result.allocations !== undefined) for (const rawAllocation of array(result.allocations, 'allocations')) {
    const row = object(rawAllocation, 'allocation'); string(row.allocationId, 'allocationId'); strings(row.spaceIds, 'allocation spaceIds');
    integer(row.sensorCount, 'allocation sensorCount'); ratio(row.targetMetRatio, 'allocation targetMetRatio');
    for (const key of ['meanHours', 'minHours', 'maxHours']) number(row[key], key);
    if (row.sampledArea !== undefined) number(row.sampledArea, 'sampledArea');
  }
  if (result.targets !== undefined) for (const rawTarget of array(result.targets, 'targets')) {
    const target = object(rawTarget, 'target'); strings(target.spaceIds, 'target spaceIds'); number(target.minHours, 'target minHours');
    if (typeof target.met !== 'boolean') fail('target met');
    if (target.worstSpaceId !== null) string(target.worstSpaceId, 'worstSpaceId');
    nullableNumber(target.worstMinHours, 'worstMinHours');
    if (target.missingSpaceIds !== undefined) strings(target.missingSpaceIds, 'missingSpaceIds');
  }
  if (result.legend !== undefined) {
    const legend = object(result.legend, 'legend'); string(legend.colorSet, 'legend.colorSet');
    if (legend.legendParameters !== undefined) object(legend.legendParameters, 'legendParameters');
  }
}

/** Transport integrity only; completed computation and target/verification outcomes remain distinct. */
export function parseCompletedEngineResult<K extends EngineCapability>(raw: unknown, capability: K,
  expectedEngineVersion: string): EngineResultByCapability[K] {
  const result = object(raw, 'result'); finiteJson(result);
  if (result.schemaVersion !== '1') fail('schemaVersion');
  if (result.engineVersion !== expectedEngineVersion) fail('engineVersion');
  if (result.status === 'failed') throw new EngineResultError(typeof result.error === 'string' && result.error.trim()
    ? result.error : '引擎报告计算失败', 'engine_failed');
  if (result.status !== 'completed') fail('status');
  if (capability === 'daylight') {
    if (result.method !== 'overcast-daylight-factor') fail('method');
    number(result.outdoorIlluminanceLux, 'outdoorIlluminanceLux');
    if ((result.outdoorIlluminanceLux as number) <= 0) fail('outdoorIlluminanceLux');
    spatialRows(result.spaces, true); strings(result.assumptions, 'assumptions');
    if (result.sampling !== undefined) sampling(result.sampling, true);
    for (const rawGrid of array(result.grids, 'grids')) {
      const mesh = grid(rawGrid, 3, 'lux'); string(mesh.spaceId, 'spaceId');
      const factors = array(mesh.daylightFactors, 'daylightFactors');
      if (factors.length !== (mesh.faces as unknown[]).length) fail('daylightFactors count');
      factors.forEach(n => number(n, 'daylightFactor'));
    }
  } else if (capability === 'sunlight') {
    const metrics = object(result.metrics, 'metrics');
    if (metrics.unit !== 'hour') fail('metrics.unit');
    integer(metrics.sensorCount, 'metrics.sensorCount'); ratio(metrics.targetAreaRatio, 'targetAreaRatio');
    spatialRows(result.spaces, false); verification(result.verification); optionalSunlightDetails(result);
    if (result.sampling !== undefined) sampling(result.sampling, false);
    if (result.grids !== undefined) for (const rawGrid of array(result.grids, 'grids')) {
      const mesh = grid(rawGrid, 3, 'hours'); string(mesh.spaceId, 'spaceId');
      if (mesh.faceColors !== undefined) {
        const colors = array(mesh.faceColors, 'faceColors');
        if (colors.length !== (mesh.faces as unknown[]).length || colors.some(color => typeof color !== 'string' || !/^#[a-fA-F0-9]{6}$/.test(color))) fail('faceColors');
      }
    }
  } else {
    if (result.scenario !== 'egress') fail('scenario');
    const metrics = object(result.metrics, 'metrics');
    if (metrics.unit !== 'second') fail('metrics.unit');
    integer(metrics.totalAgents, 'totalAgents'); nullableNumber(metrics.egressTimeSec, 'egressTimeSec');
    nullableNumber(metrics.meanEgressTimeSec, 'meanEgressTimeSec'); strings(metrics.bottleneckSpaceIds, 'bottleneckSpaceIds');
    for (const rawDoor of array(metrics.peakDoorDensity, 'peakDoorDensity')) {
      const door = object(rawDoor, 'door metrics'); string(door.exitId, 'exitId');
      number(door.peakDensity, 'peakDensity'); number(door.flowRate, 'flowRate');
    }
    verification(result.verification);
    if (result.densityGrid !== undefined) grid(result.densityGrid, 2, 'density');
    if (result.trajectories !== undefined) for (const rawTrajectory of array(result.trajectories, 'trajectories')) {
      const trajectory = object(rawTrajectory, 'trajectory'); integer(trajectory.agentId, 'agentId'); string(trajectory.spaceId, 'spaceId');
      const times = array(trajectory.times, 'times'), points = array(trajectory.points, 'points');
      if (times.length !== points.length) fail('trajectory point/time count');
      times.forEach((time, i) => { number(time, 'trajectory time'); if (i && (time as number) < (times[i - 1] as number)) fail('trajectory time order'); });
      for (const rawPoint of points) { const point = array(rawPoint, 'point'); if (point.length !== 2) fail('point dimension'); point.forEach(n => number(n, 'point coordinate', false)); }
    }
  }
  return result as unknown as EngineResultByCapability[K];
}
