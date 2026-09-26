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
