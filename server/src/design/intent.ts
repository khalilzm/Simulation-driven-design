// 意图 schema：Agent 输出的"要什么"（房间、关系、约束），不含任何几何。
// 布局器把它编译成 LayoutPlanV2（坐标计划），评估层判定是否兑现。

export type Orientation =
  | 'north' | 'northeast' | 'east' | 'southeast'
  | 'south' | 'southwest' | 'west' | 'northwest';

export type Priority = 'hard' | 'soft';
export type Privacy = 'public' | 'semi-private' | 'private';
export type AdjacencyRelation = 'adjacent' | 'near' | 'separated';

export const INTENT_SCHEMA_VERSION = 1 as const;

export const ORIENTATIONS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

const ORIENTATION_SET = new Set<string>(ORIENTATIONS);
const ENTRANCE_SIDE_SET = new Set<string>([...ORIENTATIONS, 'any']);
const PRIORITY_SET = new Set<string>(['hard', 'soft']);
const PRIVACY_SET = new Set<string>(['public', 'semi-private', 'private']);
const RELATION_SET = new Set<string>(['adjacent', 'near', 'separated']);
const CIRCULATION_ORIENTATION_SET = new Set<string>(['horizontal', 'vertical']);
const CIRCULATION_POSITION_SET = new Set<string>(['start', 'center', 'end']);
const SWING_SET = new Set<string>(['left', 'right', 'none']);

export interface IntentBuilding {
  totalArea?: { min?: number; target?: number };
  entrance?: { side: Orientation | 'any'; note?: string };
  /** 墙厚（米），默认 0.12 */
  wallThickness?: number;
  /** 墙高（米），默认 3 */
  wallHeight?: number;
}

export interface WindowIntent {
  /** 窗户属于哪个空间 */
  spaceId: string;
  /** 开在空间的哪条朝向的外墙（south/north/east/west 等） */
  orientation: Orientation;
  /** 在墙上的位置：start（起点）/center（中点，默认）/end（终点） */
  position?: 'start' | 'center' | 'end';
  /** 窗宽（米） */
  width: number;
  /** 窗高（米） */
  height: number;
  /** 窗台离地（米），0 = 落地窗，默认 0.9 */
  sillHeight?: number;
}

export interface DoorIntent {
  /** 门连接的两个空间 id（或 corridor id） */
  connects: [string, string];
  /** 门扇开启方向，默认 left */
  swing?: 'left' | 'right' | 'none';
  /** 门扇数：1 单开 / 2 双开，默认 1 */
  leafCount?: 1 | 2;
  /** 门宽（米），必填 */
  width: number;
  /** 门高（米），必填 */
  height: number;
  /** 在共享墙上的位置：start/center/end，默认 center */
  position?: 'start' | 'center' | 'end';
}

export interface RoomIntent {
  id: string;
  usage: string;
  area: { min?: number; target?: number };
  orientation?: Orientation[];
  privacy?: Privacy;
  priority?: Priority;
}

export interface AdjacencyIntent {
  a: string;
  b: string;
  relation: AdjacencyRelation;
  priority?: Priority;
}

export interface DaylightTarget {
  roomIds: string[];
  minHours: number;
  priority?: Priority;
}

export type CirculationOrientation = 'horizontal' | 'vertical';

export interface CirculationIntent {
  id: string;
  usage: string;
  orientation: CirculationOrientation;
  /** 走廊宽度（米），默认 1.5 */
  width?: number;
  /** 沿主方向的位置：start（贴 min 侧）/center（居中）/end（贴 max 侧），默认 center */
  position?: 'start' | 'center' | 'end';
}

export interface DesignIntent {
  schemaVersion: typeof INTENT_SCHEMA_VERSION;
  units: 'm';
  building: IntentBuilding;
  rooms: RoomIntent[];
  /** 交通骨架（走廊/门厅）：布局器先放置，其余房间围绕排布 */
  circulation?: CirculationIntent[];
  /** 门意图：连接哪两个空间 + 门规格；未声明的相邻房间对仍由算法补可达性门 */
  doors?: DoorIntent[];
  /** 窗意图：每扇窗属于哪个空间、开在哪条边、位置与尺寸 */
  windows?: WindowIntent[];
  adjacencies: AdjacencyIntent[];
  daylight: DaylightTarget[];
  assumptions: string[];
  unmetRequirements: string[];
}

export type ParseIntentResult =
  | { ok: true; intent: DesignIntent }
  | { ok: false; errors: string[] };

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonneg(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    errors.push(`${field} 必须是非负数`);
    return undefined;
  }
  return value;
}

function positive(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    errors.push(`${field} 必须是正数`);
    return undefined;
  }
  return value;
}

function oneOf(value: unknown, allowed: ReadonlySet<string>, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) {
    errors.push(`${field} 必须是 ${[...allowed].join('/')} 之一`);
    return undefined;
  }
  return value;
}

function stringArray(value: unknown, field: string, errors: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${field} 必须是字符串数组`);
    return [];
  }
  return value as string[];
}

export function parseDesignIntent(raw: unknown): ParseIntentResult {
  const errors: string[] = [];
  const root = record(raw);
  if (!root) return { ok: false, errors: ['意图必须是 JSON 对象'] };

  if (root.schemaVersion !== INTENT_SCHEMA_VERSION) errors.push(`schemaVersion 必须为 ${INTENT_SCHEMA_VERSION}`);
  if (root.units !== undefined && root.units !== 'm') errors.push('units 目前仅支持 "m"');

  const building: IntentBuilding = {};
  if (root.building !== undefined) {
    const b = record(root.building);
    if (!b) errors.push('building 必须是对象');
    else {
      if (b.totalArea !== undefined) {
        const t = record(b.totalArea);
        if (!t) errors.push('building.totalArea 必须是对象');
        else {
          const min = nonneg(t.min, 'building.totalArea.min', errors);
          const target = nonneg(t.target, 'building.totalArea.target', errors);
          if (min !== undefined && target !== undefined && min > target) {
            errors.push('building.totalArea.min 不能大于 target');
          }
          building.totalArea = { min, target };
        }
      }
      if (b.entrance !== undefined) {
        const e = record(b.entrance);
        if (!e) errors.push('building.entrance 必须是对象');
        else {
          const side = oneOf(e.side, ENTRANCE_SIDE_SET, 'building.entrance.side', errors) as (Orientation | 'any') | undefined;
          if (side) building.entrance = { side, note: typeof e.note === 'string' ? e.note : undefined };
        }
      }
      const wallThickness = positive(b.wallThickness, 'building.wallThickness', errors);
      const wallHeight = positive(b.wallHeight, 'building.wallHeight', errors);
      if (wallThickness !== undefined) building.wallThickness = wallThickness;
      if (wallHeight !== undefined) building.wallHeight = wallHeight;
    }
  }

  const rooms: RoomIntent[] = [];
  const knownRoomIds = new Set<string>();
  if (!Array.isArray(root.rooms) || root.rooms.length === 0 || root.rooms.length > 64) {
    errors.push('rooms 需要包含 1～64 个房间');
  } else {
    for (let i = 0; i < root.rooms.length; i++) {
      const item = record(root.rooms[i]);
      const at = `rooms[${i}]`;
      if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }

      const id = typeof item.id === 'string' ? item.id : '';
      if (!id) errors.push(`${at}.id 缺失`);
      else if (id === 'outside') errors.push(`${at}.id 不能是保留标识 outside`);
      else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) errors.push(`${at}.id 须为字母开头的英文标识`);
      else if (knownRoomIds.has(id)) errors.push(`房间 id 重复：${id}`);
      else knownRoomIds.add(id);

      const usage = typeof item.usage === 'string' ? item.usage.trim() : '';
      if (!usage) errors.push(`${at}.usage 缺失`);

      const area: { min?: number; target?: number } = {};
      if (item.area !== undefined) {
        const a = record(item.area);
        if (!a) errors.push(`${at}.area 必须是对象`);
        else {
          const min = nonneg(a.min, `${at}.area.min`, errors);
          const target = nonneg(a.target, `${at}.area.target`, errors);
          if (min !== undefined && target !== undefined && min > target) errors.push(`${at}.area.min 不能大于 target`);
          area.min = min;
          area.target = target;
        }
      }

      let orientation: Orientation[] | undefined;
      if (item.orientation !== undefined) {
        if (!Array.isArray(item.orientation)) errors.push(`${at}.orientation 必须是数组`);
        else {
          const list: Orientation[] = [];
          item.orientation.forEach((o, j) => {
            const v = oneOf(o, ORIENTATION_SET, `${at}.orientation[${j}]`, errors) as Orientation | undefined;
            if (v && !list.includes(v)) list.push(v);
          });
          if (list.length) orientation = list;
        }
      }

      const privacy = oneOf(item.privacy, PRIVACY_SET, `${at}.privacy`, errors) as Privacy | undefined;
      const priority = oneOf(item.priority, PRIORITY_SET, `${at}.priority`, errors) as Priority | undefined;

      rooms.push({
        id, usage, area,
        ...(orientation ? { orientation } : {}),
        ...(privacy ? { privacy } : {}),
        ...(priority ? { priority } : {}),
      });
    }
  }

  const circulation: CirculationIntent[] = [];
  if (root.circulation !== undefined) {
    if (!Array.isArray(root.circulation)) errors.push('circulation 必须是数组');
    else {
      const circIds = new Set<string>();
      for (let i = 0; i < root.circulation.length; i++) {
        const item = record(root.circulation[i]);
        const at = `circulation[${i}]`;
        if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id) errors.push(`${at}.id 缺失`);
        else if (id === 'outside') errors.push(`${at}.id 不能是保留标识 outside`);
        else if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) errors.push(`${at}.id 须为字母开头的英文标识`);
        else if (knownRoomIds.has(id)) errors.push(`${at}.id 与房间 id 冲突：${id}`);
        else if (circIds.has(id)) errors.push(`circulation id 重复：${id}`);
        else circIds.add(id);
        const usage = typeof item.usage === 'string' ? item.usage.trim() : '';
        if (!usage) errors.push(`${at}.usage 缺失`);
        const orientation = oneOf(item.orientation, CIRCULATION_ORIENTATION_SET, `${at}.orientation`, errors) as CirculationOrientation | undefined;
        let width: number | undefined;
        if (item.width !== undefined) {
          if (typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width <= 0) {
            errors.push(`${at}.width 必须是正数（米）`);
          } else width = item.width;
        }
        const position = oneOf(item.position, CIRCULATION_POSITION_SET, `${at}.position`, errors) as ('start' | 'center' | 'end') | undefined;
        if (id && usage && orientation) {
          circulation.push({ id, usage, orientation, ...(width !== undefined ? { width } : {}), ...(position !== undefined ? { position } : {}) });
        }
      }
    }
  }

  const doors: DoorIntent[] = [];
  if (root.doors !== undefined) {
    if (!Array.isArray(root.doors)) errors.push('doors 必须是数组');
    else {
      const allIds = new Set<string>([...knownRoomIds, ...circulation.map((c) => c.id)]);
      for (let i = 0; i < root.doors.length; i++) {
        const item = record(root.doors[i]);
        const at = `doors[${i}]`;
        if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }
        let connects: [string, string] | undefined;
        if (!Array.isArray(item.connects) || item.connects.length !== 2 || item.connects.some((id) => typeof id !== 'string')) {
          errors.push(`${at}.connects 必须是两个空间 id`);
        } else {
          const [a, b] = item.connects as [string, string];
          if (a === b) errors.push(`${at}.connects 两侧空间不能相同`);
          else if (!allIds.has(a) || !allIds.has(b)) errors.push(`${at}.connects 引用了不存在的空间 ${!allIds.has(a) ? a : b}`);
          else connects = [a, b];
        }
        const swing = oneOf(item.swing, SWING_SET, `${at}.swing`, errors) as ('left' | 'right' | 'none') | undefined;
        let leafCount: 1 | 2 | undefined;
        if (item.leafCount !== undefined) {
          if (item.leafCount !== 1 && item.leafCount !== 2) errors.push(`${at}.leafCount 只能是 1 或 2`);
          else leafCount = item.leafCount;
        }
        const width = positive(item.width, `${at}.width`, errors);
        const height = positive(item.height, `${at}.height`, errors);
        if (item.width === undefined) errors.push(`${at}.width 缺失`);
        if (item.height === undefined) errors.push(`${at}.height 缺失`);
        const position = oneOf(item.position, CIRCULATION_POSITION_SET, `${at}.position`, errors) as ('start' | 'center' | 'end') | undefined;
        if (connects && width !== undefined && height !== undefined) {
          doors.push({ connects, width, height, ...(swing ? { swing } : {}), ...(leafCount !== undefined ? { leafCount } : {}), ...(position !== undefined ? { position } : {}) });
        }
      }
    }
  }

  const windows: WindowIntent[] = [];
  if (root.windows !== undefined) {
    if (!Array.isArray(root.windows)) errors.push('windows 必须是数组');
    else {
      const allIds = new Set<string>([...knownRoomIds, ...circulation.map((c) => c.id)]);
      for (let i = 0; i < root.windows.length; i++) {
        const item = record(root.windows[i]);
        const at = `windows[${i}]`;
        if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }
        const spaceId = typeof item.spaceId === 'string' ? item.spaceId : '';
        if (!spaceId) errors.push(`${at}.spaceId 缺失`);
        else if (!allIds.has(spaceId)) errors.push(`${at}.spaceId 引用了不存在的空间 ${spaceId}`);
        const orientation = oneOf(item.orientation, ORIENTATION_SET, `${at}.orientation`, errors) as Orientation | undefined;
        if (item.orientation === undefined) errors.push(`${at}.orientation 缺失`);
        const width = positive(item.width, `${at}.width`, errors);
        const height = positive(item.height, `${at}.height`, errors);
        if (item.width === undefined) errors.push(`${at}.width 缺失`);
        if (item.height === undefined) errors.push(`${at}.height 缺失`);
        const position = oneOf(item.position, CIRCULATION_POSITION_SET, `${at}.position`, errors) as ('start' | 'center' | 'end') | undefined;
        const sillHeight = nonneg(item.sillHeight, `${at}.sillHeight`, errors);
        if (spaceId && orientation && width !== undefined && height !== undefined) {
          windows.push({ spaceId, orientation, width, height, ...(position !== undefined ? { position } : {}), ...(sillHeight !== undefined ? { sillHeight } : {}) });
        }
      }
    }
  }

  const adjacencies: AdjacencyIntent[] = [];
  if (root.adjacencies !== undefined) {
    if (!Array.isArray(root.adjacencies)) errors.push('adjacencies 必须是数组');
    else {
      for (let i = 0; i < root.adjacencies.length; i++) {
        const item = record(root.adjacencies[i]);
        const at = `adjacencies[${i}]`;
        if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }
        const a = typeof item.a === 'string' ? item.a : '';
        const b = typeof item.b === 'string' ? item.b : '';
        if (!a || !b) errors.push(`${at} 缺少 a 或 b`);
        else {
          if (!knownRoomIds.has(a)) errors.push(`${at}.a 引用了不存在的房间 ${a}`);
          if (!knownRoomIds.has(b)) errors.push(`${at}.b 引用了不存在的房间 ${b}`);
          if (a === b) errors.push(`${at} 两侧房间不能相同`);
        }
        const relation = oneOf(item.relation, RELATION_SET, `${at}.relation`, errors) as AdjacencyRelation | undefined;
        const priority = oneOf(item.priority, PRIORITY_SET, `${at}.priority`, errors) as Priority | undefined;
        if (a && b && a !== b && relation && knownRoomIds.has(a) && knownRoomIds.has(b)) {
          adjacencies.push({ a, b, relation, ...(priority ? { priority } : {}) });
        }
      }
    }
  }

  const daylight: DaylightTarget[] = [];
  if (root.daylight !== undefined) {
    if (!Array.isArray(root.daylight)) errors.push('daylight 必须是数组');
    else {
      for (let i = 0; i < root.daylight.length; i++) {
        const item = record(root.daylight[i]);
        const at = `daylight[${i}]`;
        if (!item) { errors.push(`${at} 必须是 JSON 对象`); continue; }
        if (!Array.isArray(item.roomIds) || item.roomIds.length === 0) {
          errors.push(`${at}.roomIds 必须是非空数组`);
          continue;
        }
        const members: string[] = [];
        let valid = true;
        item.roomIds.forEach((rid, j) => {
          if (typeof rid !== 'string' || !knownRoomIds.has(rid)) {
            errors.push(`${at}.roomIds[${j}] 引用了不存在的房间 ${String(rid)}`);
            valid = false;
          } else if (!members.includes(rid)) members.push(rid);
        });
        let minHours: number | undefined;
        if (item.minHours === undefined) errors.push(`${at}.minHours 缺失`);
        else minHours = nonneg(item.minHours, `${at}.minHours`, errors);
        const priority = oneOf(item.priority, PRIORITY_SET, `${at}.priority`, errors) as Priority | undefined;
        if (valid && members.length && minHours !== undefined) {
          daylight.push({ roomIds: members, minHours, ...(priority ? { priority } : {}) });
        }
      }
    }
  }

  const assumptions = stringArray(root.assumptions, 'assumptions', errors);
  const unmetRequirements = stringArray(root.unmetRequirements, 'unmetRequirements', errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    intent: {
      schemaVersion: INTENT_SCHEMA_VERSION, units: 'm', building, rooms,
      ...(circulation.length ? { circulation } : {}),
      ...(doors.length ? { doors } : {}),
      ...(windows.length ? { windows } : {}),
      adjacencies, daylight, assumptions, unmetRequirements,
    },
  };
}
