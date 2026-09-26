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
  /** 物理空间 ID 或稳定 allocationId；逻辑功能 ID 包含其所有分片。 */
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
  allocationId?: string;
  sensorCount: number;
  /** 网格代表面积之和（平方米），不一定覆盖空间全部边缘。 */
  sampledArea?: number;
  /** 按网格代表面积加权的平均时长。 */
  meanHours: number;
  minHours: number;
  maxHours: number;
  /** 目标覆盖网格中达标面积的比例；重叠目标采用最高 minHours，无目标时为 null。 */
  targetMetRatio: number | null;
}

export interface SunlightAllocationMetrics extends Omit<SunlightSpaceMetrics, 'spaceId' | 'allocationId'> {
  allocationId: string;
  spaceIds: string[];
}

export interface SunlightTargetCheck {
  spaceIds: string[];
  minHours: number;
  met: boolean;
  worstSpaceId: string | null;
  worstMinHours: number | null;
  missingSpaceIds?: string[];
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
    /** 所有目标覆盖网格的达标面积 / 代表面积，去重计数；缺失目标测点时为 null。 */
    targetAreaRatio: number | null;
  };
  spaces: SunlightSpaceMetrics[];
  /** 按稳定逻辑功能汇总；spaces 保留物理分片，以兼容平面显示。 */
  allocations?: SunlightAllocationMetrics[];
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
    if (typeof l.latitude !== 'number' || !Number.isFinite(l.latitude) || l.latitude < -90 || l.latitude > 90) errors.push('location.latitude 无效');
    if (typeof l.longitude !== 'number' || !Number.isFinite(l.longitude) || l.longitude < -180 || l.longitude > 180) errors.push('location.longitude 无效');
    if (typeof l.timezone !== 'string' || !l.timezone.trim()) errors.push('location.timezone 必填');
    else {
      try { new Intl.DateTimeFormat('en', { timeZone: l.timezone.trim() }); }
      catch { errors.push('location.timezone 须为有效的 IANA 时区'); }
    }
  }

  if (typeof o.analysisDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.analysisDate)) {
    errors.push('analysisDate 须为 YYYY-MM-DD');
  } else {
    const date = new Date(`${o.analysisDate}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.toISOString().slice(0, 10) !== o.analysisDate) {
      errors.push('analysisDate 须为有效日期');
    }
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
  if (typeof o.timestepMinutes !== 'number' || !Number.isInteger(o.timestepMinutes) || o.timestepMinutes < 1 || o.timestepMinutes > 120) {
    errors.push('timestepMinutes 须为 1～120 的整数');
  }

  const sensors = o.sensors;
  if (!sensors || typeof sensors !== 'object') {
    errors.push('sensors 必填');
  } else {
    const s = sensors as Record<string, unknown>;
    if (typeof s.referenceHeightAboveFloor !== 'number' || !Number.isFinite(s.referenceHeightAboveFloor) || s.referenceHeightAboveFloor < 0) {
      errors.push('sensors.referenceHeightAboveFloor 须为非负数');
    }
    if (typeof s.gridSpacing !== 'number' || !Number.isFinite(s.gridSpacing) || s.gridSpacing <= 0) {
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
        const idsValid = Array.isArray(tr.spaceIds) && tr.spaceIds.length > 0
          && tr.spaceIds.every((id) => typeof id === 'string' && id.trim());
        if (!idsValid) {
          errors.push(`targets[${i}].spaceIds 须为非空空间 ID 数组`);
        }
        if (typeof tr.minHours !== 'number' || !Number.isFinite(tr.minHours) || tr.minHours < 0) {
          errors.push(`targets[${i}].minHours 须为非负数`);
        } else if (idsValid) {
          targets.push({
            spaceIds: [...new Set((tr.spaceIds as string[]).map((id) => id.trim()))],
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
    localTimeRange: [String((range as unknown[])[0]).trim(), String((range as unknown[])[1]).trim()],
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
