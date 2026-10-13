import { buildEffectiveCatalog, TYPE_ID_KEY, type DesignPatch, type OffsetPartitionPatch, type OptimizationEvaluation, type OptimizationRequest, type SpaceModel, type SwapProgramPatch, type Vec2 } from '@sdd/shared';
import { buildSpatialGraph } from '../geometry/spatialGraph';
import { validateModel } from '../model/validate';
import { validateAgentModel } from '../model/validateAgent';
import { segmentCoveredBy } from '../design/layoutWalls';
import { closePolygon } from '../geometry/polygon';

export function validateOptimizationModel(model: SpaceModel): void {
  const errors = [...validateModel(model).errors, ...validateAgentModel(model).errors];
  if (errors.length) throw new Error(`优化需要有效模型：${[...new Set(errors)].join('；')}`);
  if (model.model.units !== 'm') throw new Error('首轮优化仅支持米制模型');
  if (model.fixedContext.length) throw new Error('首轮人流优化暂不支持尚未转换为墙体障碍的固定设施');
  const floor = closePolygon(model.floor.boundary);
  const segments = model.walls.flatMap((w) => w.geometry.points.slice(1)
    .map((p, i): [Vec2, Vec2] => [w.geometry.points[i], p]));
  if (floor.slice(1).some((p, i) => !segmentCoveredBy(floor[i], p, segments))) {
    throw new Error('首轮优化需要由墙体围合的真实外轮廓，不能使用未围合的草图包围盒');
  }
}

/** 定位可改门洞及其宿主墙；越权（fixed/structural/curtain/目录 structural）与折线墙直接拒绝。 */
function resolveEditableOpening(model: SpaceModel, openingId: string): { opening: SpaceModel['openings'][number]; wall: SpaceModel['walls'][number] } {
  const opening = model.openings.find((o) => o.id === openingId);
  if (!opening || !model.doors.some((d) => d.openingId === opening.id)) throw new Error('请选择现有门洞');
  const wall = model.walls.find((w) => w.id === opening.hostWallId);
  const typeId = wall?.analysisProperties?.[TYPE_ID_KEY];
  const catalogRole = typeof typeId === 'string' ? buildEffectiveCatalog(model.componentTypes ?? []).get(typeId)?.role : undefined;
  if (!wall || wall.fixed || wall.role === 'structural' || wall.role === 'curtain' || catalogRole === 'structural') {
    throw new Error('固定墙、承重墙或幕墙上的门洞不在本轮修改范围');
  }
  if (wall.geometry.points.length < 2 || !isApproximatelyStraight(wall.geometry.points)) throw new Error('首轮仅支持直墙上的门洞');
  return { opening, wall };
}

/** 洞口跨度（中心 position、宽 width）须在墙内、不重叠相邻门窗、不跨墙交点。 */
function assertOpeningFits(model: SpaceModel, wall: SpaceModel['walls'][number],
  opening: SpaceModel['openings'][number], position: number, width: number, action: '增宽' | '移动'): void {
  const [a, b] = wallEndpoints(wall.geometry.points);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const left = position - width / 2, right = position + width / 2;
  // 少量几何余量避免与相邻墙实体相交。
  const margin = wall.thickness / 2;
  if (left < margin || right > length - margin) throw new Error(`${action}后的洞口过于接近墙端`);
  if (model.openings.some((o) => o.id !== opening.id && o.hostWallId === wall.id
    && Math.abs(o.position - position) < (o.width + width) / 2 + margin)) {
    throw new Error(`${action}后的洞口与相邻门窗重叠或间距不足`);
  }
  const ux = (b[0] - a[0]) / length, uy = (b[1] - a[1]) / length;
  // 把其他墙投影到宿主坐标，拒绝穿越/接触实体。
  for (const other of model.walls) {
    if (other.id === wall.id) continue;
    for (let i = 0; i + 1 < other.geometry.points.length; i++) {
      const coords = other.geometry.points.slice(i, i + 2).map(([x, y]) => ({
        s: (x - a[0]) * ux + (y - a[1]) * uy,
        t: -(x - a[0]) * uy + (y - a[1]) * ux,
      }));
      const [p, q] = coords, band = (wall.thickness + other.thickness) / 2;
      if (Math.min(p.t, q.t) > band || Math.max(p.t, q.t) < -band) continue;
      const dt = q.t - p.t;
      let lo = 0, hi = 1;
      if (Math.abs(dt) > 1e-9) {
        const t0 = (-band - p.t) / dt, t1 = (band - p.t) / dt;
        lo = Math.max(0, Math.min(t0, t1)); hi = Math.min(1, Math.max(t0, t1));
      }
      if (lo > hi) continue;
      const s0 = p.s + lo * (q.s - p.s), s1 = p.s + hi * (q.s - p.s);
      if (Math.max(s0, s1) + other.thickness / 2 > left && Math.min(s0, s1) - other.thickness / 2 < right) {
        throw new Error(`${action}后的洞口与墙 ${other.id} 的连接位置冲突`);
      }
    }
  }
}

function sameVec(a: Vec2, b: Vec2): boolean {
  return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
}

/** 手绘草图墙常在交点被切成多段；共线多段仍按直墙处理。 */
const WALL_STRAIGHT_TOL_M = 0.01;

function isApproximatelyStraight(points: Vec2[]): boolean {
  if (points.length <= 2) return true;
  const a = points[0], b = points[points.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return true;
  return points.every((p) => Math.abs(dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / length <= WALL_STRAIGHT_TOL_M);
}

/** 直墙（含共线多段）的有效两端点。 */
function wallEndpoints(points: Vec2[]): [Vec2, Vec2] {
  return [points[0], points[points.length - 1]];
}

/** 隔墙沿右手法向小位移；平移墙与两侧房间共享边顶点，校验后整组提交。 */
function applyOffsetPartition(model: SpaceModel, patch: OffsetPartitionPatch): SpaceModel {
  const wall = model.walls.find((w) => w.id === patch.wallId);
  if (!wall || wall.geometry.points.length < 2 || !isApproximatelyStraight(wall.geometry.points)) throw new Error('首轮仅支持直墙的隔墙偏移');
  if (wall.fixed || wall.role === 'structural' || wall.role === 'curtain') throw new Error('固定墙、承重墙或幕墙不在本轮修改范围');
  const [a, b] = wallEndpoints(wall.geometry.points);
  if (!sameVec(a, patch.expectedFrom) || !sameVec(b, patch.expectedTo)) throw new Error('隔墙位置已变化，请重新选择方案');
  if (!Number.isFinite(patch.offsetM) || Math.abs(patch.offsetM) > 0.6) throw new Error('隔墙偏移须在 ±0.6 米内');
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) throw new Error('隔墙几何无效');
  const ox = (-dy / length) * patch.offsetM, oy = (dx / length) * patch.offsetM;
  const next = structuredClone(model);
  const w = next.walls.find((x) => x.id === wall.id)!;
  w.geometry.points = wall.geometry.points.map((p) => [p[0] + ox, p[1] + oy]);
  for (const space of next.spaces) {
    space.boundary = space.boundary.map((p) => wall.geometry.points.some((wp) => sameVec(p, wp)) ? [p[0] + ox, p[1] + oy] : p);
  }
  const validation = validateModel(next);
  if (!validation.valid) throw new Error(validation.errors.join('；'));
  return next;
}

/** 交换两个空间的功能身份：usage/typeId/allocationId/性能偏好随功能迁移，几何与洞口不变。 */
function applySwapProgram(model: SpaceModel, patch: SwapProgramPatch): SpaceModel {
  const a = model.spaces.find((s) => s.id === patch.spaceA);
  const b = model.spaces.find((s) => s.id === patch.spaceB);
  if (!a || !b) throw new Error('请选择现有的两个空间');
  if (a.id === b.id) throw new Error('请选择两个不同的空间');
  const next = structuredClone(model);
  const na = next.spaces.find((s) => s.id === a.id)!;
  const nb = next.spaces.find((s) => s.id === b.id)!;
  [na.usage, nb.usage] = [nb.usage, na.usage];
  [na.typeId, nb.typeId] = [nb.typeId, na.typeId];
  [na.allocationId, nb.allocationId] = [nb.allocationId, na.allocationId];
  [na.performancePreferences, nb.performancePreferences] = [nb.performancePreferences, na.performancePreferences];
  const validation = validateModel(next);
  if (!validation.valid) throw new Error(validation.errors.join('；'));
  return next;
}

/** 定位可改外窗及其宿主墙；越权（fixed/structural/curtain）与折线墙直接拒绝。 */
function resolveEditableWindow(model: SpaceModel, openingId: string): { opening: SpaceModel['openings'][number]; wall: SpaceModel['walls'][number] } {
  const opening = model.openings.find((o) => o.id === openingId);
  if (!opening || !model.windows.some((w) => w.openingId === opening.id)) throw new Error('请选择现有外窗');
  const wall = model.walls.find((w) => w.id === opening.hostWallId);
  const typeId = wall?.analysisProperties?.[TYPE_ID_KEY];
  const catalogRole = typeof typeId === 'string' ? buildEffectiveCatalog(model.componentTypes ?? []).get(typeId)?.role : undefined;
  if (!wall || wall.fixed || wall.role === 'structural' || wall.role === 'curtain' || catalogRole === 'structural') {
    throw new Error('固定墙、承重墙或幕墙上的外窗不在本轮修改范围');
  }
  if (wall.geometry.points.length < 2 || !isApproximatelyStraight(wall.geometry.points)) throw new Error('首轮仅支持直墙上的外窗');
  return { opening, wall };
}

/** 日照不足空间的外窗候选：增宽（两档）+ 沿墙小位移（两向）。 */
export function candidateWindowPatches(model: SpaceModel, baseline: OptimizationEvaluation): DesignPatch[] {
  const low = new Set(baseline.sunlight.spaces.filter((s) => s.targetMetRatio != null && s.targetMetRatio < 1).map((s) => s.spaceId));
  if (!low.size) return [];
  const graph = buildSpatialGraph(model);
  const patches: DesignPatch[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== 'window' || !edge.openingId || !edge.wallId) continue;
    if (!low.has(edge.from) && !low.has(edge.to)) continue;
    const opening = model.openings.find((o) => o.id === edge.openingId);
    const wall = model.walls.find((w) => w.id === edge.wallId);
    if (!opening || !wall || wall.geometry.points.length < 2 || !isApproximatelyStraight(wall.geometry.points)) continue;
    const maxWidthM = Number((opening.width + 0.4).toFixed(4));
    for (const widthM of [Number((opening.width + 0.2).toFixed(4)), maxWidthM]) {
      patches.push({ type: 'resizeWindow', openingId: opening.id, expectedWidthM: opening.width, widthM, maxWidthM });
    }
    const [a, b] = wallEndpoints(wall.geometry.points);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const step = Math.max(0.3, Math.min(0.6, length * 0.2));
    for (const position of [opening.position - step, opening.position + step]) {
      if (position <= 0) continue;
      patches.push({ type: 'moveWindow', openingId: opening.id, expectedPosition: opening.position, position: Number(position.toFixed(4)) });
    }
  }
  return patches;
}

/** 实施领域操作补丁；前置值校验 + 几何校验 + 整组原子应用。 */
export function applyDesignPatch(model: SpaceModel, patch: DesignPatch): SpaceModel {
  if (model.model.units !== 'm') throw new Error('首轮优化仅支持米制模型');
  if (patch.type === 'resizeOpening') {
    const { opening, wall } = resolveEditableOpening(model, patch.openingId);
    if (Math.abs(opening.width - patch.expectedWidthM) > 1e-6) throw new Error('门洞尺寸已变化，请重新选择方案');
    if (!Number.isFinite(patch.widthM) || patch.widthM <= opening.width || patch.widthM > patch.maxWidthM + 1e-6) {
      throw new Error('候选门宽必须增加且在指定上限内');
    }
    assertOpeningFits(model, wall, opening, opening.position, patch.widthM, '增宽');
    const next = structuredClone(model);
    next.openings.find((o) => o.id === opening.id)!.width = patch.widthM;
    const validation = validateModel(next);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    return next;
  }
  if (patch.type === 'moveOpening') {
    const { opening, wall } = resolveEditableOpening(model, patch.openingId);
    if (Math.abs(opening.position - patch.expectedPosition) > 1e-6) throw new Error('门洞位置已变化，请重新选择方案');
    if (!Number.isFinite(patch.position) || patch.position < 0) throw new Error('候选门位无效');
    assertOpeningFits(model, wall, opening, patch.position, opening.width, '移动');
    const next = structuredClone(model);
    next.openings.find((o) => o.id === opening.id)!.position = patch.position;
    const validation = validateModel(next);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    return next;
  }
  if (patch.type === 'offsetPartition') {
    return applyOffsetPartition(model, patch);
  }
  if (patch.type === 'swapProgram') {
    return applySwapProgram(model, patch);
  }
  if (patch.type === 'resizeWindow') {
    const { opening, wall } = resolveEditableWindow(model, patch.openingId);
    if (Math.abs(opening.width - patch.expectedWidthM) > 1e-6) throw new Error('外窗尺寸已变化，请重新选择方案');
    if (!Number.isFinite(patch.widthM) || patch.widthM <= opening.width || patch.widthM > patch.maxWidthM + 1e-6) {
      throw new Error('候选外窗宽度必须增加且在指定上限内');
    }
    assertOpeningFits(model, wall, opening, opening.position, patch.widthM, '增宽');
    const next = structuredClone(model);
    next.openings.find((o) => o.id === opening.id)!.width = patch.widthM;
    const validation = validateModel(next);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    return next;
  }
  if (patch.type === 'moveWindow') {
    const { opening, wall } = resolveEditableWindow(model, patch.openingId);
    if (Math.abs(opening.position - patch.expectedPosition) > 1e-6) throw new Error('外窗位置已变化，请重新选择方案');
    if (!Number.isFinite(patch.position) || patch.position < 0) throw new Error('候选外窗位无效');
    assertOpeningFits(model, wall, opening, patch.position, opening.width, '移动');
    const next = structuredClone(model);
    next.openings.find((o) => o.id === opening.id)!.position = patch.position;
    const validation = validateModel(next);
    if (!validation.valid) throw new Error(validation.errors.join('；'));
    return next;
  }
  throw new Error('未知补丁类型');
}

/** 首轮单目标入口：门洞增宽。位置、房间身份、人口与其余几何保持不变。 */
export function widenDoor(model: SpaceModel, request: OptimizationRequest, widthM: number): SpaceModel {
  if (!request.confirmEditable) throw new Error('请明确选择允许改造的门洞及宿主墙');
  return applyDesignPatch(model, { type: 'resizeOpening', openingId: request.openingId,
    expectedWidthM: request.expectedWidthM, widthM, maxWidthM: request.maxWidthM });
}

export function candidateWidths(request: OptimizationRequest): number[] {
  const delta = request.maxWidthM - request.expectedWidthM;
  return [...new Set([0.5, 1].map((t) => Number((request.expectedWidthM + t * delta).toFixed(4))))]
    .filter((width) => width > request.expectedWidthM && width <= request.maxWidthM + 1e-6);
}

/** 首轮可试算的补丁集合：门洞增宽（2 档）+ 沿墙小位移（2 个方向）。 */
export function candidatePatches(model: SpaceModel, request: OptimizationRequest): DesignPatch[] {
  const patches: DesignPatch[] = candidateWidths(request).map((widthM) => ({
    type: 'resizeOpening', openingId: request.openingId, expectedWidthM: request.expectedWidthM, widthM, maxWidthM: request.maxWidthM,
  }));
  const opening = model.openings.find((o) => o.id === request.openingId);
  const wall = opening ? model.walls.find((w) => w.id === opening.hostWallId) : undefined;
  if (!opening || !wall || wall.geometry.points.length < 2 || !isApproximatelyStraight(wall.geometry.points)) return patches;
  const [a, b] = wallEndpoints(wall.geometry.points);
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const step = Math.max(0.3, Math.min(0.6, length * 0.2));
  for (const position of [opening.position - step, opening.position + step]) {
    if (position <= 0) continue;
    patches.push({ type: 'moveOpening', openingId: request.openingId, expectedPosition: opening.position, position: Number(position.toFixed(4)) });
  }
  return patches;
}

/** 日照不足空间相邻的可改直隔墙，各试两个方向的小位移（日照驱动，候选墙为待验证假设）。 */
export function candidatePartitionOffsets(model: SpaceModel, baseline: OptimizationEvaluation): OffsetPartitionPatch[] {
  const low = new Set(baseline.sunlight.spaces
    .filter((s) => s.targetMetRatio != null && s.targetMetRatio < 1).map((s) => s.spaceId));
  if (!low.size) return [];
  const graph = buildSpatialGraph(model);
  const walls = new Map<string, { from: Vec2; to: Vec2 }>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'adjacency' || edge.locked || !edge.wallId) continue;
    if (!low.has(edge.from) && !low.has(edge.to)) continue;
    const wall = model.walls.find((w) => w.id === edge.wallId);
    if (wall && wall.geometry.points.length >= 2 && isApproximatelyStraight(wall.geometry.points)) {
      walls.set(edge.wallId, { from: wall.geometry.points[0], to: wall.geometry.points[wall.geometry.points.length - 1] });
    }
  }
  const patches: OffsetPartitionPatch[] = [];
  for (const [wallId, { from, to }] of walls) {
    for (const offsetM of [0.3, -0.3]) {
      patches.push({ type: 'offsetPartition', wallId, expectedFrom: from, expectedTo: to, offsetM });
    }
  }
  return patches;
}

/** 交通/辅助空间不参与功能交换（走廊、门厅、玄关等）。 */
const CIRCULATION_USAGES = ['走廊', '门厅', '玄关', '过道', '走道', '通道', '连廊', 'corridor', 'hall', 'lobby', 'foyer', 'circulation'];

function isCirculation(model: SpaceModel, spaceId: string): boolean {
  const space = model.spaces.find((s) => s.id === spaceId);
  if (!space) return false;
  const usage = space.usage.trim();
  return CIRCULATION_USAGES.some((kw) => usage.includes(kw));
}

/** 功能交换候选：低日照且有目标的空间 ↔ 明显更亮的功能空间（排除交通空间）。 */
export function candidateProgramSwaps(model: SpaceModel, baseline: OptimizationEvaluation): SwapProgramPatch[] {
  const low = baseline.sunlight.spaces.filter((s) => s.targetMetRatio != null && s.targetMetRatio < 1);
  const free = baseline.sunlight.spaces.filter((s) => s.targetMetRatio == null && !isCirculation(model, s.spaceId));
  const patches: SwapProgramPatch[] = [];
  for (const a of low) {
    for (const b of free) {
      if (a.spaceId === b.spaceId) continue;
      // 只换明显更亮（多 0.5h 以上）的房间，避免换完不改善
      if (b.meanHours > a.meanHours + 0.5) {
        patches.push({ type: 'swapProgram', spaceA: a.spaceId, spaceB: b.spaceId });
      }
    }
  }
  return patches;
}
