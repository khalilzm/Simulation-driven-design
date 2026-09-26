// 日照工况与结果契约（对齐 docs/architecture.md §7、docs/protocol.md）

export const SUNLIGHT_CONFIG_SCHEMA_VERSION = '1';
export const SUNLIGHT_RESULT_SCHEMA_VERSION = '1';

export interface SunlightLocation {
  latitude: number;
  longitude: number;
  /** IANA 时区，如 Asia/Shanghai */
  timezone: string;
}

export interface SunlightSensors {
  /** 室内测点相对楼板标高的高度（米） */
  referenceHeightAboveFloor: number;
  /** 平面网格间距（米） */
  gridSpacing: number;
}

export interface SunlightTarget {
  spaceIds: string[];
  minHours: number;
}

export interface SunlightConfig {
  schemaVersion: string;
  location: SunlightLocation;
  /** 分析日，ISO 日期 YYYY-MM-DD */
  analysisDate: string;
  /** 当地分析时段 [开始, 结束]，24h 格式 HH:mm */
  localTimeRange: [string, string];
  /** 模型 +Y 轴逆时针转到真北的角度（度），与 Ladybug/Honeybee north 一致 */
  northDegrees: number;
  timestepMinutes: number;
  sensors: SunlightSensors;
  targets?: SunlightTarget[];
}

export type SunlightVerificationStatus = 'passed' | 'failed' | 'needs_review';

export interface SunlightSpaceMetrics {
  spaceId: string;
  sensorCount: number;
  meanHours: number;
  minHours: number;
  maxHours: number;
  /** 测点中累计时长 >= 对应 target.minHours 的比例；无 target 时为 null */
  targetMetRatio: number | null;
}

export interface SunlightTargetCheck {
  spaceIds: string[];
  minHours: number;
  met: boolean;
  worstSpaceId: string | null;
  worstMinHours: number | null;
}

export interface SunlightSensorGridMesh {
  gridId: string;
  spaceId: string;
  vertices: [number, number, number][];
  faces: number[][];
  hours: number[];
  /** Ladybug Legend.value_colors 的 #RRGGBB，与 GH 着色一致 */
  faceColors?: string[];
}

export interface SunlightResult {
  schemaVersion: string;
  status: 'completed' | 'failed';
  engineVersion: string;
  metrics: {
    unit: 'hour';
    sensorCount: number;
    targetAreaRatio: number | null;
  };
  spaces: SunlightSpaceMetrics[];
  targets?: SunlightTargetCheck[];
  /** Honeybee SensorGrid 网格与逐面累计直射小时（Ladybug 色标） */
  grids?: SunlightSensorGridMesh[];
  legend?: { colorSet: string; legendParameters?: Record<string, unknown> };
  verification: {
    status: SunlightVerificationStatus;
    checks: string[];
  };
  error?: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseTimeMinutes(s: string): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseSunlightConfig(raw: unknown): { ok: true; config: SunlightConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['config 必须是对象'] };
  }
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== SUNLIGHT_CONFIG_SCHEMA_VERSION) {
    errors.push(`schemaVersion 须为 "${SUNLIGHT_CONFIG_SCHEMA_VERSION}"`);
  }

  const loc = o.location;
  if (!loc || typeof loc !== 'object') {
    errors.push('location 必填');
  } else {
    const l = loc as Record<string, unknown>;
    if (typeof l.latitude !== 'number' || l.latitude < -90 || l.latitude > 90) errors.push('location.latitude 无效');
    if (typeof l.longitude !== 'number' || l.longitude < -180 || l.longitude > 180) errors.push('location.longitude 无效');
    if (typeof l.timezone !== 'string' || !l.timezone.trim()) errors.push('location.timezone 必填');
  }

  if (typeof o.analysisDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.analysisDate)) {
    errors.push('analysisDate 须为 YYYY-MM-DD');
  }

  const range = o.localTimeRange;
  if (!Array.isArray(range) || range.length !== 2) {
    errors.push('localTimeRange 须为 [HH:mm, HH:mm]');
  } else {
    const a = parseTimeMinutes(String(range[0]));
    const b = parseTimeMinutes(String(range[1]));
    if (a === null || b === null) errors.push('localTimeRange 时间格式无效');
    else if (b <= a) errors.push('localTimeRange 结束须晚于开始');
  }

  if (typeof o.northDegrees !== 'number' || !Number.isFinite(o.northDegrees)) {
    errors.push('northDegrees 须为数字');
  }
  if (typeof o.timestepMinutes !== 'number' || o.timestepMinutes <= 0 || o.timestepMinutes > 120) {
    errors.push('timestepMinutes 须在 (0, 120]');
  }

  const sensors = o.sensors;
  if (!sensors || typeof sensors !== 'object') {
    errors.push('sensors 必填');
  } else {
    const s = sensors as Record<string, unknown>;
    if (typeof s.referenceHeightAboveFloor !== 'number' || s.referenceHeightAboveFloor < 0) {
      errors.push('sensors.referenceHeightAboveFloor 须为非负数');
    }
    if (typeof s.gridSpacing !== 'number' || s.gridSpacing <= 0) {
      errors.push('sensors.gridSpacing 须为正数');
    }
  }

  const targets: SunlightTarget[] = [];
  if (o.targets !== undefined) {
    if (!Array.isArray(o.targets)) {
      errors.push('targets 须为数组');
    } else {
      for (const [i, t] of o.targets.entries()) {
        if (!t || typeof t !== 'object') {
          errors.push(`targets[${i}] 无效`);
          continue;
        }
        const tr = t as Record<string, unknown>;
        if (!Array.isArray(tr.spaceIds) || tr.spaceIds.some((id) => typeof id !== 'string')) {
          errors.push(`targets[${i}].spaceIds 须为字符串数组`);
        }
        if (typeof tr.minHours !== 'number' || tr.minHours < 0) {
          errors.push(`targets[${i}].minHours 须为非负数`);
        } else {
          targets.push({
            spaceIds: (tr.spaceIds as string[]).map((id) => id.trim()).filter(Boolean),
            minHours: tr.minHours,
          });
        }
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  const l = (loc as Record<string, unknown>);
  const s = (sensors as Record<string, unknown>);
  const config: SunlightConfig = {
    schemaVersion: SUNLIGHT_CONFIG_SCHEMA_VERSION,
    location: {
      latitude: l.latitude as number,
      longitude: l.longitude as number,
      timezone: String(l.timezone).trim(),
    },
    analysisDate: o.analysisDate as string,
    localTimeRange: [String((range as unknown[])[0]), String((range as unknown[])[1])],
    northDegrees: o.northDegrees as number,
    timestepMinutes: o.timestepMinutes as number,
    sensors: {
      referenceHeightAboveFloor: s.referenceHeightAboveFloor as number,
      gridSpacing: s.gridSpacing as number,
    },
    targets: targets.length ? targets : undefined,
  };
  return { ok: true, config };
}
