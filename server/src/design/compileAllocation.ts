import type { SpaceModel, SpaceType, Vec2, Wall } from '@sdd/shared';
import { polygonGeometryError, pointInOrOnPolygon } from '@sdd/shared';
import { polygonArea } from '../model/geometry';
import { applyRegionSplits, type Allocation, type LayoutRegion, type RegionCatalog, type RegionSplit } from './layoutRegions';
import { cleanRing, decomposeRegions, geometryArea, outsideArea, segmentOverlap, unionRings } from './regionGeometry';

interface AllocationPlan {
  splits: RegionSplit[];
  allocations: Allocation[];
  assumptions: string[];
  unmetRequirements: string[];
  floorHeight?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('布局必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${field} 必须是非空字符串数组（数组本身可空）`);
  return value as string[];
}

function parsePlan(raw: unknown): AllocationPlan {
  const root = record(raw);
  for (const field of ['model', 'floor', 'spaces', 'walls', 'boundary']) {
    if (field in root) throw new Error(`不要输出 ${field} 或几何坐标；只提交 splits 和 allocations，几何由区域 ID 生成`);
  }
  if (!Array.isArray(root.allocations) || !root.allocations.length || root.allocations.length > 64) throw new Error('allocations 需要包含 1～64 个功能分配');
  const allocations = root.allocations.map((rawAllocation) => {
    const item = record(rawAllocation);
    if (typeof item.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(item.id)) throw new Error('allocation.id 须为字母开头的英文标识');
    if (typeof item.usage !== 'string' || !item.usage.trim()) throw new Error(`${item.id} 缺少具体功能 usage`);
    if (typeof item.enclosed !== 'boolean') throw new Error(`${item.id}.enclosed 必须是布尔值`);
    if ('boundary' in item || 'rect' in item) throw new Error(`${item.id} 只允许引用 regionIds，不能提交任意边界`);
    for (const key of ['targetArea', 'minArea']) if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0)) throw new Error(`${item.id}.${key} 必须是非负平方米数`);
    return { id: item.id, usage: item.usage.trim(), enclosed: item.enclosed,
      regionIds: strings(item.regionIds, `${item.id}.regionIds`), targetArea: item.targetArea as number | undefined, minArea: item.minArea as number | undefined };
  });
  if (root.splits !== undefined && !Array.isArray(root.splits)) throw new Error('splits 必须是数组');
  if (root.floorHeight !== undefined && (typeof root.floorHeight !== 'number' || !Number.isFinite(root.floorHeight) || root.floorHeight <= 0)) throw new Error('floorHeight 必须是正数（米）');
  return { allocations, splits: (root.splits ?? []) as RegionSplit[],
    assumptions: strings(root.assumptions ?? [], 'assumptions'), unmetRequirements: strings(root.unmetRequirements ?? [], 'unmetRequirements'),
    floorHeight: root.floorHeight as number | undefined };
}

function connected(regions: LayoutRegion[]): boolean {
  const wanted = new Set(regions.map((region) => region.id));
  const seen = new Set<string>();
  const queue = regions.length ? [regions[0].id] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const neighbor of regions.find((region) => region.id === id)!.adjacentIds) {
      if (wanted.has(neighbor) && !seen.has(neighbor)) queue.push(neighbor);
    }
  }
  return seen.size === regions.length;
}

/** 仅增补未被既有墙覆盖的区间；保持门窗宿主墙的 ID 和几何。 */
function appendWalls(walls: Wall[], rings: Vec2[][], height: number, thickness: number): void {
  for (const ring of rings) for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i], b = ring[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    if (length2 < 1e-14) continue;
    const position = (p: Vec2) => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2;
    const covered: [number, number][] = [];
    for (const wall of walls) for (let j = 0; j + 1 < wall.geometry.points.length; j++) {
      const overlap = segmentOverlap(a, b, wall.geometry.points[j], wall.geometry.points[j + 1]);
      if (overlap) covered.push([position(overlap[0]), position(overlap[1])]);
    }
    covered.sort((x, y) => x[0] - y[0]);
    let cursor = 0;
    const gaps: [number, number][] = [];
    for (const [start, end] of covered) {
      if (start > cursor + 1e-8) gaps.push([cursor, start]);
      cursor = Math.max(cursor, end);
    }
    if (cursor < 1 - 1e-8) gaps.push([cursor, 1]);
    for (const [start, end] of gaps) {
      const point = (t: number): Vec2 => [a[0] + t * dx, a[1] + t * dy];
      let n = walls.length + 1;
      while (walls.some((wall) => wall.id === `layout-wall-${n}`)) n++;
      walls.push({ id: `layout-wall-${n}`, geometry: { type: 'polyline', points: [point(start), point(end)] }, height, thickness, fixed: false });
    }
  }
}

const PALETTE = ['#A8C8F0', '#98D4B8', '#FFE4A8', '#C8B8E8', '#FFB878', '#88C8E8', '#FFD0A0'];

export function compileAllocation(raw: unknown, catalog: RegionCatalog, revisionId: string, requireFullCoverage = false): {
  model: SpaceModel; warnings: string[]; assumptions: string[];
} {
  const plan = parsePlan(raw);
  const regions = applyRegionSplits(catalog, plan.splits);
  const scale = catalog.units === 'mm' ? 1000 : 1;
  const used = new Set<string>(), ids = new Set<string>();
  const warnings = plan.unmetRequirements.map((item) => `未满足：${item}`);
  const parent = catalog.parent;
  const protectedHosts = new Set(parent?.openings.map((opening) => opening.hostWallId) ?? []);
  const walls = structuredClone(parent?.walls.filter((wall) => wall.fixed || protectedHosts.has(wall.id)) ?? []);
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId, parentRevisionId: parent?.model.revisionId ?? null, units: catalog.units, origin: [...catalog.origin] },
    floor: structuredClone(catalog.floor), spaceTypes: [], spaces: [], walls,
    componentTypes: structuredClone(parent?.componentTypes),
    openings: structuredClone(parent?.openings ?? []), doors: structuredClone(parent?.doors ?? []), windows: structuredClone(parent?.windows ?? []),
    fixedContext: structuredClone(parent?.fixedContext ?? []), externalContext: structuredClone(parent?.externalContext ?? []),
  };
  if (plan.floorHeight !== undefined) model.floor.height = plan.floorHeight * scale;
  const types = new Map<string, SpaceType>();
  const enclosureRings: Vec2[][] = [];
  for (const allocation of plan.allocations) {
    if (ids.has(allocation.id)) throw new Error(`功能 ID 重复：${allocation.id}`);
    ids.add(allocation.id);
    if (!allocation.regionIds.length) throw new Error(`${allocation.id} 尚未分配区域；放不下的需求请写入 unmetRequirements`);
    const assigned = allocation.regionIds.map((id) => {
      const region = regions.find((item) => item.id === id);
      if (!region) throw new Error(`区域 ${id} 不存在或已被切分；切分后应使用 .a/.b 子区域`);
      if (used.has(id)) throw new Error(`区域 ${id} 被重复分配，每个区域只能属于一个功能`);
      used.add(id); return region;
    });
    if (allocation.enclosed && !connected(assigned)) throw new Error(`${allocation.id} 的封闭房间不连通；选择有共边的区域或拆成独立房间`);
    const combined = unionRings(assigned.map((region) => region.boundary));
    const area = geometryArea(combined) / scale ** 2;
    if (allocation.minArea !== undefined && area + 1e-6 < allocation.minArea) throw new Error(`${allocation.id} 实际 ${area.toFixed(2)} m²，小于要求 ${allocation.minArea} m²；请调整分配`);
    if (allocation.targetArea && area < allocation.targetArea * 0.75) warnings.push(`${allocation.usage} 实际 ${area.toFixed(1)} m²，低于目标 ${allocation.targetArea} m²`);
    if (!allocation.enclosed && !connected(assigned)) warnings.push(`${allocation.usage} 分为多个不连通区域`);
    if (allocation.enclosed) {
      const perimeter = combined.flat().reduce((sum, ring) => sum + ring.slice(1).reduce((length, p, i) =>
        length + Math.hypot(p[0] - ring[i][0], p[1] - ring[i][1]), 0), 0) / scale;
      if (2 * area / perimeter < 0.5) warnings.push(`${allocation.usage} 形状狭长或面积很小，建议合并相邻区域后复核使用空间`);
      // 同一封闭房间不能越过保留的固定墙。区域中心线两侧都在房间内即视为跨墙。
      for (const wall of walls) for (let i = 0; i + 1 < wall.geometry.points.length; i++) {
        const a = wall.geometry.points[i], b = wall.geometry.points[i + 1];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (!length) continue;
        const delta = 1e-5 * scale;
        for (const t of [0.1, 0.5, 0.9]) {
          const mid: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
          const p: Vec2 = [mid[0] - (b[1] - a[1]) / length * delta, mid[1] + (b[0] - a[0]) / length * delta];
          const q: Vec2 = [2 * mid[0] - p[0], 2 * mid[1] - p[1]];
          const inside = (point: Vec2) => combined.some((rings) => pointInOrOnPolygon(point, rings[0]) && !rings.slice(1).some((hole) => pointInOrOnPolygon(point, hole)));
          if (inside(p) && inside(q)) throw new Error(`${allocation.id} 跨越保留墙 ${wall.id}；请切分区域并分别安排功能`);
        }
      }
      enclosureRings.push(...combined.flat());
    }
    let type = types.get(allocation.usage);
    if (!type) {
      type = { id: `layout-type-${types.size + 1}`, label: allocation.usage, color: PALETTE[types.size % PALETTE.length] };
      types.set(allocation.usage, type); model.spaceTypes!.push(type);
    }
    const parts = combined.flatMap((polygon) => polygon.length === 1 && !polygonGeometryError(cleanRing(polygon[0]))
      ? [cleanRing(polygon[0])] : decomposeRegions([polygon]));
    parts.forEach((boundary, index) => {
      if (outsideArea(boundary, catalog.floor.boundary) / scale ** 2 > 1e-6 || polygonGeometryError(boundary)) throw new Error(`${allocation.id} 几何编译未通过轮廓检查`);
      model.spaces.push({ id: index === 0 ? allocation.id : `${allocation.id}-part-${index + 1}`, allocationId: allocation.id,
        enclosed: allocation.enclosed, usage: allocation.usage, typeId: type!.id, boundary,
        targetArea: allocation.targetArea ? allocation.targetArea * polygonArea(boundary) / scale ** 2 / area : 0, performancePreferences: {} });
    });
  }
  const unused = regions.filter((region) => !used.has(region.id));
  if (requireFullCoverage && unused.length) throw new Error(`要求铺满，但这些区域未分配：${unused.map((region) => region.id).join('、')}；请安排功能、交通或明确预留区`);
  if (unused.length) warnings.push(`尚有 ${unused.reduce((sum, region) => sum + region.area, 0).toFixed(1)} m² 未分配区域`);
  appendWalls(walls, [catalog.floor.boundary, ...enclosureRings], model.floor.height, 0.12 * scale);
  return { model, warnings, assumptions: plan.assumptions };
}
