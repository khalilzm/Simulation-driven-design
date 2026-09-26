import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSunlightConfig } from '@sdd/shared';

test('parseSunlightConfig 接受标准工况', () => {
  const parsed = parseSunlightConfig({
    schemaVersion: '1',
    location: { latitude: 31.2, longitude: 121.5, timezone: 'Asia/Shanghai' },
    analysisDate: '2025-12-21',
    localTimeRange: ['08:00', '16:00'],
    northDegrees: 0,
    timestepMinutes: 60,
    sensors: { referenceHeightAboveFloor: 0.75, gridSpacing: 1 },
  });
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.config.location.timezone, 'Asia/Shanghai');
  }
});

test('parseSunlightConfig 拒绝无效时段', () => {
  const parsed = parseSunlightConfig({
    schemaVersion: '1',
    location: { latitude: 0, longitude: 0, timezone: 'UTC' },
    analysisDate: '2025-12-21',
    localTimeRange: ['16:00', '08:00'],
    northDegrees: 0,
    timestepMinutes: 60,
    sensors: { referenceHeightAboveFloor: 0.75, gridSpacing: 1 },
  });
  assert.equal(parsed.ok, false);
});

const validConfig = {
  schemaVersion: '1',
  location: { latitude: 31.2, longitude: 121.5, timezone: 'Asia/Shanghai' },
  analysisDate: '2025-12-21', localTimeRange: ['08:00', '16:00'],
  northDegrees: 0, timestepMinutes: 60,
  sensors: { referenceHeightAboveFloor: 0.75, gridSpacing: 1 },
};

test('日照工况拒绝不存在的时区、日期以及会截断或卡住计算的步长', () => {
  for (const patch of [
    { location: { ...validConfig.location, timezone: 'Invalid/Zone' } },
    { analysisDate: '2025-02-29' }, { analysisDate: '2025-04-31' },
    { timestepMinutes: 0.5 }, { timestepMinutes: 15.5 }, { timestepMinutes: NaN },
    { location: { ...validConfig.location, latitude: NaN } },
    { sensors: { ...validConfig.sensors, gridSpacing: Infinity } },
  ]) {
    assert.equal(parseSunlightConfig({ ...validConfig, ...patch }).ok, false);
  }
  assert.equal(parseSunlightConfig({ ...validConfig, analysisDate: '2024-02-29' }).ok, true);
});

test('目标空间格式错误返回校验错误，空目标不能成为自动通过的目标', () => {
  for (const spaceIds of [null, 'room', [], [''], ['room', null]]) {
    const result = parseSunlightConfig({ ...validConfig, targets: [{ spaceIds, minHours: 1 }] });
    assert.equal(result.ok, false);
  }
  assert.equal(parseSunlightConfig({ ...validConfig, targets: [{ spaceIds: ['room'], minHours: NaN }] }).ok, false);
  const result = parseSunlightConfig({ ...validConfig, targets: [{ spaceIds: [' room ', 'room'], minHours: 1 }] });
  assert.ok(result.ok);
  assert.deepEqual(result.config.targets, [{ spaceIds: ['room'], minHours: 1 }]);
});
