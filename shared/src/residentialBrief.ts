import type { SpaceModel } from './model';
import { parseSunlightConfig, type SunlightConfig } from './sunlight';

export type RequirementPriority = 'hard' | 'soft';
export type RoomKind = 'living' | 'bedroom' | 'kitchen' | 'bathroom' | 'study' | 'circulation' | 'other';
export type RelationKind = 'direct' | 'adjacent' | 'public_access' | 'no_direct';
export const ROOM_LABELS: Record<RoomKind, string> = { living: '客餐厅', bedroom: '卧室', kitchen: '厨房', bathroom: '卫生间', study: '书房', circulation: '公共交通空间', other: '其他空间' };
export const RELATION_LABELS: Record<RelationKind, string> = { direct: '直接连通', adjacent: '相邻', public_access: '经公共空间可达', no_direct: '禁止直接连通' };
export interface RoomRequirement {
  id: string;
  name: string;
  kind: RoomKind;
  area: { min: number; target: number; max: number };
  window: 'required' | 'preferred' | 'none';
  sunlight: { enabled: boolean; minHours: number; minAreaRatio: number; priority: RequirementPriority };
  /** Only these rooms may be crossed on a public_access route. Living/circulation default to true. */
  allowThrough?: boolean;
  /** Optional user-defined furniture/body requirement, in metres. */
  bodySize?: [number, number];
  /** Graph coordinates are diagram layout only, never floor-plan coordinates. */
  position: { x: number; y: number };
}
export interface RoomRelation {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  priority: RequirementPriority;
}
export interface ResidentialLayoutSettings {
  gridSize: number;
  passageWidth: number;
  doorWidth: number;
  doorDepth: number;
}
export const DEFAULT_LAYOUT_SETTINGS: ResidentialLayoutSettings = { gridSize: .5, passageWidth: .9, doorWidth: .9, doorDepth: .9 };
export const layoutSettings = (brief: ResidentialBrief): ResidentialLayoutSettings => ({ ...DEFAULT_LAYOUT_SETTINGS, ...brief.layout });
export const permitsThrough = (room: RoomRequirement) => room.allowThrough ?? ['living','circulation'].includes(room.kind);
export interface ResidentialBrief {
  schemaVersion: '1';
  baseRevisionId: string;
  rooms: RoomRequirement[];
  relations: RoomRelation[];
  sunlight: SunlightConfig;
  notes: string;
  layout?: ResidentialLayoutSettings;
}
export interface ResidentialBriefDocument {
  brief: ResidentialBrief;
  baseModelHash: string;
  version: number;
  updatedAt: string;
}
export interface BriefIssue { level: 'error' | 'warning'; message: string; nodeId?: string }
export const entranceNodeId = (doorId: string) => `entrance:${doorId}`;

export function createResidentialBrief(baseRevisionId: string): ResidentialBrief {
  return { schemaVersion: '1', baseRevisionId, rooms: [], relations: [], notes: '',
    sunlight: { schemaVersion: '1', location: { latitude: 31.2304, longitude: 121.4737, timezone: 'Asia/Shanghai' },
      analysisDate: '2026-12-21', localTimeRange: ['08:00', '16:00'], northDegrees: 0, timestepMinutes: 30,
      sensors: { referenceHeightAboveFloor: 0.75, gridSpacing: 0.5 } } };
}

/** Editable two-bedroom program; diagram positions never prescribe the generated floor plan. */
export function createResidentialPreset(baseRevisionId: string, entranceDoorId?: string): ResidentialBrief {
  const brief = createResidentialBrief(baseRevisionId);
  const room = (id: string, name: string, kind: RoomKind, area: [number, number, number], x: number, y: number): RoomRequirement => ({
    id, name, kind, area: { min: area[0], target: area[1], max: area[2] },
    window: kind === 'bedroom' ? 'required' : kind === 'bathroom' ? 'none' : 'preferred',
    sunlight: { enabled: kind === 'bedroom', minHours: 2, minAreaRatio: 0.5, priority: 'soft' }, position: { x, y },
  });
  brief.rooms = [
    room('room-living', '客餐厅', 'living', [20,28,40], 0.4,0.48),
    room('room-main', '主卧', 'bedroom', [10,14,22], 0.72,0.2),
    room('room-second', '次卧', 'bedroom', [10,12,20], 0.72,0.44),
    room('room-kitchen', '厨房', 'kitchen', [5,7,12], 0.4,0.8),
    room('room-bathroom', '公共卫生间', 'bathroom', [3,5,8], 0.72,0.8),
  ];
  const relation = (id: string, from: string, to: string, kind: RelationKind, priority: RequirementPriority = 'hard'): RoomRelation => ({id:`rel-${id}`,from,to,kind,priority});
  brief.relations = [
    relation('living-kitchen','room-living','room-kitchen','direct'),
    relation('kitchen-bathroom','room-kitchen','room-bathroom','adjacent','soft'),
    relation('kitchen-main','room-kitchen','room-main','no_direct'),
    relation('kitchen-second','room-kitchen','room-second','no_direct'),
  ];
  if (entranceDoorId) brief.relations.push(...brief.rooms.map(r =>
    relation(`entry-${r.id}`, entranceNodeId(entranceDoorId), r.id, r.kind === 'living' ? 'direct' : 'public_access')));
  return brief;
}

/** Structural validation is shared by drafts and task admission; semantic readiness is checked separately. */
export function parseResidentialBrief(raw: unknown): ResidentialBrief {
  const fail = (message: string): never => { throw new Error(message); };
  if (!raw || typeof raw !== 'object') return fail('空间需求必须为对象');
  const b = raw as ResidentialBrief;
  if (b.schemaVersion !== '1' || !/^rev-\d+$/.test(b.baseRevisionId)) fail('空间需求版本或底图版本无效');
  if (!Array.isArray(b.rooms) || b.rooms.length > 32 || !Array.isArray(b.relations) || b.relations.length > 200) fail('最多支持 32 个房间、200 条关系');
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (b.layout && (!['gridSize','passageWidth','doorWidth','doorDepth'].every(k => finite(b.layout![k as keyof ResidentialLayoutSettings])) || b.layout.gridSize < .2 || b.layout.gridSize > 1 || b.layout.passageWidth < .6 || b.layout.passageWidth > 2 || b.layout.doorWidth < .6 || b.layout.doorWidth > 1.5 || b.layout.doorDepth < .6 || b.layout.doorDepth > 2)) fail('布局参数超出支持范围');
  const ids = new Set<string>();
  for (const r of b.rooms) {
    if (!r || typeof r.id !== 'string' || !/^room-[a-zA-Z0-9_-]+$/.test(r.id) || ids.has(r.id)) fail('房间 ID 无效或重复');
    ids.add(r.id);
    if (typeof r.name !== 'string' || r.name.length > 60 || !Object.hasOwn(ROOM_LABELS, r.kind)) fail('房间名称或类型无效');
    if (!r.area || ![r.area.min, r.area.target, r.area.max].every((n) => finite(n) && n > 0)) fail(`${r.name || '房间'} 面积须为正数`);
    if (r.area.min > r.area.target || r.area.target > r.area.max) fail(`${r.name || '房间'} 面积须满足：最小 ≤ 期望 ≤ 最大`);
    if (!['required','preferred','none'].includes(r.window)) fail('外窗需求无效');
    if (r.allowThrough !== undefined && typeof r.allowThrough !== 'boolean') fail('穿行许可必须为布尔值');
    if (r.bodySize !== undefined && (!Array.isArray(r.bodySize) || r.bodySize.length !== 2 || !r.bodySize.every(n => finite(n) && n >= .5 && n <= 20))) fail('主体尺寸须为0.5～20m的两个数值');
    const s = r.sunlight;
    if (!s || typeof s.enabled !== 'boolean' || !finite(s.minHours) || s.minHours < 0 || s.minHours > 24
      || !finite(s.minAreaRatio) || s.minAreaRatio <= 0 || s.minAreaRatio > 1 || !['hard','soft'].includes(s.priority)) fail('房间日照目标无效');
    if (!r.position || ![r.position.x,r.position.y].every((n) => finite(n) && n >= 0 && n <= 1)) fail('节点图位置无效');
  }
  const edgeIds = new Set<string>();
  for (const e of b.relations) {
    if (!e || typeof e.id !== 'string' || !/^rel-[a-zA-Z0-9_-]+$/.test(e.id) || edgeIds.has(e.id)) fail('关系 ID 无效或重复');
    edgeIds.add(e.id);
    if (typeof e.from !== 'string' || typeof e.to !== 'string' || e.from === e.to) fail('关系必须连接两个不同节点');
    if (![e.from,e.to].every((id) => ids.has(id) || /^entrance:[A-Za-z][\w-]*$/.test(id))) fail('关系引用了不存在的节点');
    if (!Object.hasOwn(RELATION_LABELS, e.kind) || !['hard','soft'].includes(e.priority)) fail('关系类型或优先级无效');
  }
  if (typeof b.notes !== 'string' || b.notes.length > 4000) fail('补充说明最多 4000 字');
  const sun = parseSunlightConfig(b.sunlight);
  if (!sun.ok) return fail(sun.errors.join('；'));
  if (sun.config.targets?.length) fail('日照目标应设置在房间节点上，不能另设全局房间目标');
  const { targets: _targets, ...globalSunlight } = sun.config;
  return structuredClone({ ...b, sunlight: globalSunlight });
}

export function checkResidentialBrief(brief: ResidentialBrief, model: SpaceModel): BriefIssue[] {
  const issues: BriefIssue[] = [];
  try { parseResidentialBrief(brief); } catch (e) { return [{ level: 'error', message: e instanceof Error ? e.message : String(e) }]; }
  const add = (level: BriefIssue['level'], message: string, nodeId?: string) => issues.push({ level, message, nodeId });
  if (!model.model.dxfSource || model.spaces.length) add('error', '请关联尚未生成房间的住宅 DXF 固定底图');
  if (brief.baseRevisionId !== model.model.revisionId) add('error', '节点图与底图版本不一致');
  if (!brief.rooms.length) add('error', '请至少添加一个房间节点');
  const names = new Set<string>();
  for (const r of brief.rooms) {
    if (!r.name.trim() || names.has(r.name.trim())) add('error', '房间名称不能为空或重复', r.id);
    names.add(r.name.trim());
    if (r.window === 'required' && !model.windows.length) add('error', `${r.name} 要求外窗，但底图没有窗洞`, r.id);
    const minutes = (s: string) => Number(s.slice(0,2))*60+Number(s.slice(3,5));
    const available = (minutes(brief.sunlight.localTimeRange[1])-minutes(brief.sunlight.localTimeRange[0]))/60;
    if (r.sunlight.enabled && r.sunlight.minHours > available) add('error', `${r.name} 的日照目标超过分析时段长度`, r.id);
  }
  const area = model.model.dxfSource?.areaM2 ?? 0;
  const min = brief.rooms.reduce((n,r) => n+r.area.min,0);
  if (min > area) add('error', `房间最小面积合计 ${min.toFixed(1)}㎡ 已超过轮廓 ${area.toFixed(1)}㎡，尚未扣除墙体和交通面积`);
  else if (brief.rooms.reduce((n,r) => n+r.area.target,0) > area*0.85) add('warning', '期望面积较紧，请为固定墙体与公共通行保留余量');
  const nodes = new Set([...brief.rooms.map((r) => r.id), ...model.doors.map((d) => entranceNodeId(d.id))]);
  const pairs = new Map<string, RoomRelation[]>();
  const entryDirect = new Map<string, Set<string>>();
  for (const e of brief.relations) {
    if (e.kind === 'direct' && e.priority === 'hard') {
      const entrance = [e.from,e.to].find(id => id.startsWith('entrance:'));
      if (entrance) {
        const targets = entryDirect.get(entrance) ?? new Set<string>();
        targets.add(e.from === entrance ? e.to : e.from); entryDirect.set(entrance,targets);
      }
    }
    if (!nodes.has(e.from) || !nodes.has(e.to)) add('error', '关系引用的入户口不在当前底图中');
    if ((e.from.startsWith('entrance:') || e.to.startsWith('entrance:')) && !['direct','public_access'].includes(e.kind)) add('error', '入户口仅支持直接连通或经公共空间可达');
    const key = [e.from,e.to].sort().join('|');
    const previous = pairs.get(key) ?? [];
    if (previous.some((p) => p.kind === e.kind)) add('error', '相同节点之间存在重复关系');
    if (e.priority === 'hard' && previous.some((p) => p.priority === 'hard' && ((p.kind === 'direct' && e.kind === 'no_direct') || (p.kind === 'no_direct' && e.kind === 'direct')))) add('error', '同一对空间不能同时要求直接连通和禁止直接连通');
    pairs.set(key,[...previous,e]);
  }
  for (const [entrance,targets] of entryDirect) if (targets.size > 1) {
    const names = [...targets].map(id => brief.rooms.find(r=>r.id===id)?.name ?? id).join('、');
    add('error', `入户口 ${entrance.slice(9)} 不能必须直接进入多个房间（${names}）。请仅保留一个直接连通房间，其余改为「经公共空间可达」`, entrance);
  }
  if (brief.rooms.length && !brief.relations.some((e) => e.from.startsWith('entrance:') || e.to.startsWith('entrance:'))) add('warning', '尚未指定入户联系；生成时仍要求所有房间从入户可达');
  if (!brief.rooms.some((r) => r.sunlight.enabled)) add('warning', '尚未设置房间日照目标；将保留全局工况，但不能据此判断房间是否达标');
  return issues;
}

export function briefSunlightConfig(brief: ResidentialBrief): SunlightConfig {
  return { ...structuredClone(brief.sunlight), targets: brief.rooms.filter((r) => r.sunlight.enabled)
    .map((r) => ({ spaceIds: [r.id], minHours: r.sunlight.minHours })) };
}

/** Persisted solver evidence; rejected geometry is diagnostic only, never an accepted design. */
export interface ResidentialSolverDiagnostics {
  status: string;
  method?: string;
  failureType?: string;
  searchVisits?: number;
  searchLimitReached?: boolean;
  gridSize?: number;
  candidateCount?: number;
  errors?: string[];
  warnings?: string[];
  failures?: {reason:string;count:number}[];
  rejectedCandidates?: {spaces:SpaceModel['spaces'];walls:SpaceModel['walls'];errors:string[]}[];
  quality?: {errors:string[];warnings:string[]};
}
