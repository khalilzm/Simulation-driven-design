import { diff, type Geometry } from 'martinez-polygon-clipping';
import { polygonGeometryError, type Floor, type SpaceModel, type Unit, type Vec2 } from '@sdd/shared';
import { boundsOf, closePolygon, polygonArea } from '../model/geometry';
import { validateLayoutCompleteness } from '../model/layoutValidation';
import { cleanRing, decomposeRegions, geometryArea, outsideArea, sharedSegments, splitRegion } from './regionGeometry';

export interface LayoutRegion {
  id: string;
  boundary: Vec2[];
  area: number;
  adjacentIds: string[];
  currentAllocationId?: string;
}

export interface Allocation {
  id: string;
  usage: string;
  regionIds: string[];
  enclosed: boolean;
  targetArea?: number;
  minArea?: number;
}

export interface RegionSplit {
  regionId: string;
  axis: 'x' | 'y';
  ratio: number;
}

export interface RegionCatalog {
  floor: Floor;
  origin: Vec2;
  units: Unit;
  regions: LayoutRegion[];
  currentAllocations: Allocation[];
  parent?: SpaceModel;
}

export function refreshAdjacency(regions: LayoutRegion[]): void {
  for (const region of regions) region.adjacentIds = [];
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    if (!sharedSegments(regions[i].boundary, regions[j].boundary).length) continue;
    regions[i].adjacentIds.push(regions[j].id);
    regions[j].adjacentIds.push(regions[i].id);
  }
}

export function createRegionCatalog(outline: string, parent?: SpaceModel): RegionCatalog {
  const input = JSON.parse(outline) as { boundary: Vec2[]; origin: Vec2; units?: Unit };
  const boundary = closePolygon(input.boundary, 0);
  const error = polygonGeometryError(boundary);
  if (error) throw new Error(`固定轮廓无效：${error}`);
  const units = input.units ?? 'm';
  const scale = units === 'mm' ? 1000 : 1;
  const regions: LayoutRegion[] = [];
  const currentAllocations: Allocation[] = [];
  const add = (geometry: Geometry, owner?: string) => {
    for (const ring of decomposeRegions(geometry)) regions.push({
      id: `r${regions.length + 1}`, boundary: ring, area: polygonArea(ring) / scale ** 2,
      adjacentIds: [], currentAllocationId: owner,
    });
  };
  let remaining: Geometry | null = [boundary];
  if (parent) {
    for (const space of parent.spaces) {
      const ring = closePolygon(space.boundary, 0);
      if (polygonGeometryError(ring) || outsideArea(ring, boundary) / scale ** 2 > 1e-6) {
        throw new Error(`父方案 ${space.id} 几何无效，不能作为可用区域来源`);
      }
      const id = space.allocationId ?? space.id;
      const start = regions.length;
      add([ring], id);
      const existing = currentAllocations.find((item) => item.id === id);
      if (existing) {
        existing.regionIds.push(...regions.slice(start).map((region) => region.id));
        existing.targetArea = (existing.targetArea ?? 0) + space.targetArea;
      }
      else currentAllocations.push({ id, usage: space.usage, enclosed: space.enclosed ?? (validateLayoutCompleteness({
        ...parent, floor: { ...parent.floor, boundary: ring },
      }).length === 0),
        regionIds: regions.slice(start).map((region) => region.id), targetArea: space.targetArea });
      if (remaining?.length) remaining = diff(remaining, [ring]);
    }
  }
  if (remaining?.length && geometryArea(remaining) > 1e-9) add(remaining);
  if (!regions.length) throw new Error('固定轮廓没有可分配的区域');
  // 确保分解既不越界，也没有因数值误差漏掉大片区域。
  const area = regions.reduce((sum, region) => sum + region.area, 0);
  if (Math.abs(area - polygonArea(boundary) / scale ** 2) > 1e-5
    || regions.some((region) => outsideArea(region.boundary, boundary) / scale ** 2 > 1e-6)) {
    throw new Error('可用区域未能精确覆盖固定轮廓');
  }
  refreshAdjacency(regions);
  return {
    floor: parent ? { ...structuredClone(parent.floor), boundary } : { boundary, elevation: 0, height: 3 * scale, topObstruction: false, bottomObstruction: false },
    origin: input.origin, units, regions, currentAllocations, parent,
  };
}

/** 每个 split 消耗一个区域并生成 .a（低坐标侧）、.b（高坐标侧）。 */
export function applyRegionSplits(catalog: RegionCatalog, splits: RegionSplit[]): LayoutRegion[] {
  const regions = structuredClone(catalog.regions);
  if (splits.length > 64) throw new Error('首版最多支持 64 次切分');
  const scale = catalog.units === 'mm' ? 1000 : 1;
  for (const split of splits) {
    const index = regions.findIndex((region) => region.id === split.regionId);
    if (index < 0) throw new Error(`切分区域 ${split.regionId} 不存在或已被消耗`);
    if (split.axis !== 'x' && split.axis !== 'y') throw new Error('split.axis 只能是 x 或 y');
    const original = regions[index];
    const parts = splitRegion(original.boundary, split.axis, split.ratio);
    if (parts.some((part) => polygonArea(part) / scale ** 2 < 0.05)) throw new Error(`${split.regionId} 切分产生小于 0.05 m² 的碎片，请调整比例`);
    regions.splice(index, 1, ...parts.map((boundary, i) => ({
      ...original, id: `${original.id}.${i === 0 ? 'a' : 'b'}`, boundary,
      area: polygonArea(boundary) / scale ** 2, adjacentIds: [],
    })));
  }
  refreshAdjacency(regions);
  return regions;
}

/** prompt 展示摘要；矩形仅给 bounds，其他区域给真实边界，避免将 bbox 误当可用轮廓。 */
export function regionSummaries(catalog: RegionCatalog) {
  return catalog.regions.map((region) => {
    const boundary = cleanRing(region.boundary);
    const b = boundsOf(boundary)!;
    const rectangular = boundary.length === 5 && boundary.slice(0, -1).every((p) =>
      (p[0] === b.minX || p[0] === b.maxX) && (p[1] === b.minY || p[1] === b.maxY));
    return {
      id: region.id, area: Number(region.area.toFixed(3)),
      ...(rectangular ? { rect: [b.minX, b.minY, b.maxX, b.maxY] } : { boundary: boundary.slice(0, -1) }),
      adjacentIds: region.adjacentIds,
      ...(region.currentAllocationId ? { currentAllocationId: region.currentAllocationId } : {}),
    };
  });
}
