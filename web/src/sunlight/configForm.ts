import {
  parseSunlightConfig,
  SUNLIGHT_CONFIG_SCHEMA_VERSION,
  type SunlightConfig,
} from '@sdd/shared';

/** 与 examples/scenarios/sunlight-rev-0001.json 一致 */
export const DEFAULT_SUNLIGHT_DRAFT: SunlightConfigDraft = {
  latitude: 31.2304,
  longitude: 121.4737,
  timezone: 'Asia/Shanghai',
  analysisDate: '2025-12-21',
  timeStart: '08:00',
  timeEnd: '16:00',
  northDegrees: 0,
  timestepMinutes: 60,
  referenceHeightAboveFloor: 0.75,
  gridSpacing: 1.0,
  floorElevation: 0,
  floorHeight: 3,
};

export interface SunlightConfigDraft {
  latitude: number;
  longitude: number;
  timezone: string;
  analysisDate: string;
  timeStart: string;
  timeEnd: string;
  northDegrees: number;
  timestepMinutes: number;
  referenceHeightAboveFloor: number;
  gridSpacing: number;
  /** model.json floor.elevation（米，绝对标高） */
  floorElevation: number;
  /** model.json floor.height（米，层高） */
  floorHeight: number;
}

export function configToDraft(config: SunlightConfig): Omit<SunlightConfigDraft, 'floorElevation' | 'floorHeight'> {
  return {
    latitude: config.location.latitude,
    longitude: config.location.longitude,
    timezone: config.location.timezone,
    analysisDate: config.analysisDate,
    timeStart: config.localTimeRange[0],
    timeEnd: config.localTimeRange[1],
    northDegrees: config.northDegrees,
    timestepMinutes: config.timestepMinutes,
    referenceHeightAboveFloor: config.sensors.referenceHeightAboveFloor,
    gridSpacing: config.sensors.gridSpacing,
  };
}

function normalizeHm(value: string): string {
  const parts = value.trim().split(':');
  if (parts.length < 2) return value.trim();
  const h = parts[0].padStart(2, '0');
  const m = parts[1].padStart(2, '0');
  return `${h}:${m}`;
}

export function draftToConfigPayload(draft: SunlightConfigDraft): unknown {
  return {
    schemaVersion: SUNLIGHT_CONFIG_SCHEMA_VERSION,
    location: {
      latitude: draft.latitude,
      longitude: draft.longitude,
      timezone: draft.timezone.trim(),
    },
    analysisDate: draft.analysisDate,
    localTimeRange: [normalizeHm(draft.timeStart), normalizeHm(draft.timeEnd)],
    northDegrees: draft.northDegrees,
    timestepMinutes: draft.timestepMinutes,
    sensors: {
      referenceHeightAboveFloor: draft.referenceHeightAboveFloor,
      gridSpacing: draft.gridSpacing,
    },
  };
}

export function validateSunlightDraft(
  draft: SunlightConfigDraft,
): { ok: true; config: SunlightConfig } | { ok: false; errors: string[] } {
  if (!Number.isFinite(draft.floorElevation)) {
    return { ok: false, errors: ['楼层标高须为有效数值'] };
  }
  if (!Number.isFinite(draft.floorHeight) || draft.floorHeight <= 0) {
    return { ok: false, errors: ['层高须为大于 0 的数值'] };
  }
  return parseSunlightConfig(draftToConfigPayload(draft));
}
