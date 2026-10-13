import type { Door, Opening, SpaceModel, SpaceType, Vec2, Wall, Window } from '@sdd/shared';
import { pointInOrOnPolygon, polygonGeometryError } from '@sdd/shared';
import { closePolygon, polygonArea } from '../geometry/polygon';
import { validateLayoutCompleteness } from '../model/layoutValidation';
import type { LayoutContext } from './layoutContext';
import type { LayoutBoundarySpec, LayoutPlanV2 } from './layoutPlanTypes';
import { buildWallsFromSegments, locateOpeningHost, segmentCoveredBy, splitBoundarySegment, wallPolylineLength, type WallCandidate } from './layoutWalls';
import { parseLayoutPlanV2, resolveSharedBoundaries, validateExplicitBoundaries } from './parseLayoutPlanV2';
import { snapExteriorBoundarySegments } from './layoutBoundarySnap';
import { parseLayoutPlan } from './parseLayoutPlan';
import { ensureSpaceInsideFloor } from './layoutSpaceBoundary';
import { snapSpaceBoundaryToFloorPlan } from './floorPlanNormalize';
import { cleanRing, outsideArea, segmentOverlap } from '../geometry/regions';
import { validateLayoutAccess } from './layoutAccess';
import { catalogTypeIdForModel } from './layoutCatalogDefaults';

const PALETTE = ['#A8C8F0', '#98D4B8', '#FFE4A8', '#C8B8E8', '#FFB878', '#88C8E8', '#FFD0A0'];

function wallSegmentsFromSpaceRing(
  ring: Vec2[],
  shared: LayoutBoundarySpec[],
  spaceId: string,
  floorBoundary: Vec2[],
): [Vec2, Vec2][] {
  const segments: [Vec2, Vec2][] = [];
  const exterior = floorBoundary.slice(1).map((point, i): [Vec2, Vec2] => [floorBoundary[i], point]);
  const adjacent = shared.filter((boundary) => boundary.leftSpaceId === spaceId || boundary.rightSpaceId === spaceId);
  for (let i = 0; i + 1 < ring.length; i++) {
    for (const [a, b] of splitBoundarySegment(ring[i], ring[i + 1], [...exterior, ...adjacent.map((item) => item.segment)])) {
      if (segmentCoveredBy(a, b, exterior)) continue;
      if (adjacent.some((boundary) => boundary.kind === 'open' && segmentCoveredBy(a, b, [boundary.segment]))) continue;
      if (adjacent.some((boundary) => boundary.kind === 'wall' && segmentCoveredBy(a, b, [boundary.segment]))) continue;
      segments.push([a, b]);
    }
  }
  return segments;
}

function segmentLength(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function compileLayoutPlan(
  raw: unknown,
  catalog: LayoutContext,
  revisionId: string,
  requireFullCoverage = false,
): { model: SpaceModel; warnings: string[]; assumptions: string[] } {
  const lenient = catalog.lenient === true;
  const plan: LayoutPlanV2 = parseLayoutPlan(raw, catalog.floor.boundary, lenient);
  if (!lenient) for (const space of plan.spaces) space.boundary = cleanRing(space.boundary);
  const scale = catalog.units === 'mm' ? 1000 : 1;
  const floorBoundary = lenient ? catalog.floor.boundary : closePolygon(catalog.floor.boundary, 0);
  const warnings = plan.unmetRequirements.map((item) => `未满足：${item}`);
  const parent = catalog.parent;
  // v2 构件采用全量提交：同 ID 可更新，省略即删除；既有建筑构件继续保护。
  const openings: Opening[] = structuredClone(parent?.openings.filter((opening) => opening.generatedBy !== 'layout-v2') ?? []);
  const protectedHosts = new Set(openings.map((opening) => opening.hostWallId));
  const walls: Wall[] = structuredClone(parent?.walls.filter((wall) => wall.fixed || protectedHosts.has(wall.id)) ?? []);
  const retainedWallIds = new Set(walls.map((wall) => wall.id));
  const retainedOpeningIds = new Set(openings.map((opening) => opening.id));
  const doors: Door[] = structuredClone(parent?.doors.filter((door) => retainedOpeningIds.has(door.openingId)) ?? []);
  const windows: Window[] = structuredClone(parent?.windows.filter((window) => retainedOpeningIds.has(window.openingId)) ?? []);

  const spaceIds = new Set<string>();
  for (const space of plan.spaces) {
    if (spaceIds.has(space.id)) throw new Error(`空间 ID 重复：${space.id}`);
    spaceIds.add(space.id);
    if (!lenient) {
      space.boundary = snapSpaceBoundaryToFloorPlan(space.boundary, floorBoundary);
      ensureSpaceInsideFloor(space, floorBoundary, scale, warnings);
    }
    const boundary = lenient ? space.boundary : cleanRing(space.boundary);
    const area = polygonArea(boundary) / scale ** 2;
    if (space.minArea !== undefined && area + 1e-6 < space.minArea) {
      warnings.push(`${space.usage}（${space.id}）实际 ${area.toFixed(2)} m²，低于下限 ${space.minArea} m²`);
    }
    if (space.targetArea && area < space.targetArea * 0.75) {
      warnings.push(`${space.usage} 实际 ${area.toFixed(1)} m²，低于目标 ${space.targetArea} m²`);
    }
  }
  let boundaries = plan.boundaries ?? [];
  if (!lenient) {
    let boundaryErrors = validateExplicitBoundaries(plan.spaces, boundaries, floorBoundary);
    if (boundaryErrors.length && boundaries.length) {
      const snapped = snapExteriorBoundarySegments(boundaries, plan.spaces, floorBoundary);
      if (snapped.notes.length) {
        boundaries = snapped.boundaries;
        warnings.push(...snapped.notes);
        boundaryErrors = validateExplicitBoundaries(plan.spaces, boundaries, floorBoundary);
      }
    }
    if (boundaryErrors.length) throw new Error(boundaryErrors[0]);
  }
  plan.boundaries = boundaries;

  const shared = resolveSharedBoundaries(plan.spaces, plan.boundaries ?? []);
  if (!lenient) {
    for (const boundary of shared.filter((item) => item.kind === 'open')) {
      if (walls.some((wall) => wall.geometry.points.slice(1).some((p, i) =>
        segmentOverlap(...boundary.segment, wall.geometry.points[i], p)))) {
        throw new Error(`开放边界 ${boundary.id} 与保留墙冲突，请设为 wall 并使用已有门洞`);
      }
    }
  }
  const wallHeight = plan.floorHeight !== undefined ? plan.floorHeight * scale : catalog.floor.height;
  const thickness = (plan.wallThickness ?? 0.12) * scale;

  if (!lenient) {
    for (const wall of walls) {
      for (let i = 0; i + 1 < wall.geometry.points.length; i++) {
        const a = wall.geometry.points[i], b = wall.geometry.points[i + 1];
        const length = segmentLength(a, b);
        if (!length) continue;
        const delta = 1e-5 * scale;
        for (const t of [0.1, 0.5, 0.9]) {
          const mid: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
          const p: Vec2 = [mid[0] - (b[1] - a[1]) / length * delta, mid[1] + (b[0] - a[0]) / length * delta];
          const q: Vec2 = [2 * mid[0] - p[0], 2 * mid[1] - p[1]];
          for (const space of plan.spaces) {
            if (!space.enclosed) continue;
            const ring = cleanRing(space.boundary);
            const inside = (point: Vec2) => pointInOrOnPolygon(point, ring);
            if (inside(p) && inside(q)) throw new Error(`${space.id} 跨越保留墙；请调整边界`);
          }
        }
      }
    }
  }

  const candidates: WallCandidate[] = [];
  for (let i = 0; i + 1 < floorBoundary.length; i++) {
    candidates.push({ a: floorBoundary[i], b: floorBoundary[i + 1] });
  }
  for (const boundary of shared) {
    if (boundary.kind !== 'wall') continue;
    candidates.push({
      a: boundary.segment[0],
      b: boundary.segment[1],
      preferredId: boundary.id.startsWith('auto-') ? undefined : `wall-${boundary.id}`,
    });
  }
  for (const space of plan.spaces) {
    if (!space.enclosed) continue;
    const ring = lenient ? space.boundary : cleanRing(space.boundary);
    for (const [a, b] of wallSegmentsFromSpaceRing(ring, shared, space.id, floorBoundary)) {
      candidates.push({ a, b });
    }
  }
  walls.push(...buildWallsFromSegments(candidates, wallHeight, thickness, 'layout-wall', walls));
  for (const wall of walls) if (!retainedWallIds.has(wall.id)) wall.generatedBy = 'layout-v2';

  const types = new Map<string, SpaceType>();
  const modelSpaces: SpaceModel['spaces'] = [];
  for (const space of plan.spaces) {
    let type = types.get(space.usage);
    if (!type) {
      type = { id: `layout-type-${types.size + 1}`, label: space.usage, color: PALETTE[types.size % PALETTE.length] };
      types.set(space.usage, type);
    }
    const boundary = lenient ? space.boundary : cleanRing(space.boundary);
    modelSpaces.push({
      id: space.id,
      allocationId: space.id,
      enclosed: space.enclosed,
      usage: space.usage,
      typeId: type.id,
      boundary,
      targetArea: space.targetArea ?? polygonArea(boundary) / scale ** 2,
      performancePreferences: {},
    });
  }

  const openingIds = new Set(openings.map((opening) => opening.id));
  for (const spec of plan.openings ?? []) {
    try {
      if (openingIds.has(spec.id)) throw new Error(`opening id 重复：${spec.id}`);
      let hostWallId = spec.hostWallId;
      let position: number;
      if (typeof spec.position === 'number') {
        position = spec.position;
      } else if (spec.hostBoundaryId) {
        position = 0;
      } else {
        throw new Error(`opening ${spec.id} 的语义位置（start/center/end）仅支持 hostBoundaryId`);
      }
      if (spec.hostBoundaryId) {
        const boundary = shared.find((item) => item.id === spec.hostBoundaryId);
        if (!boundary || boundary.kind !== 'wall') throw new Error(`opening ${spec.id} 需要有效的 wall 边界 ${spec.hostBoundaryId}`);
        const [a, b] = boundary.segment, length = segmentLength(a, b);
        if (typeof spec.position === 'string') {
          const ratio = spec.position === 'start' ? 0.25 : spec.position === 'end' ? 0.75 : 0.5;
          position = length * ratio;
        }
        if (position - spec.width / 2 < -1e-6 || position + spec.width / 2 > length + 1e-6) {
          throw new Error(`opening ${spec.id} 超出墙边界 ${boundary.id}`);
        }
        const point = (s: number): Vec2 => [a[0] + (b[0] - a[0]) * s / length, a[1] + (b[1] - a[1]) * s / length];
        const resolved = locateOpeningHost(walls, point(position - spec.width / 2), point(position + spec.width / 2));
        if (!resolved) throw new Error(`opening ${spec.id} 找不到完整覆盖洞口的宿主墙；请避开墙段接缝`);
        hostWallId = resolved.hostWallId;
        position = resolved.position;
      }
      if (!hostWallId) throw new Error(`opening ${spec.id} 缺少有效宿主墙`);
      const wall = walls.find((item) => item.id === hostWallId);
      if (!wall) throw new Error(`opening ${spec.id} 的 hostWallId ${hostWallId} 不存在`);
      const total = wallPolylineLength(wall.geometry.points);
      if (position + spec.width / 2 > total + 1e-6 || position - spec.width / 2 < -1e-6) {
        throw new Error(`opening ${spec.id} 超出墙 ${hostWallId} 可用长度 ${total.toFixed(3)}`);
      }
      if ((spec.sillHeight ?? 0) + spec.height > wall.height + 1e-6) throw new Error(`opening ${spec.id} 顶部超过宿主墙高度`);
      openings.push({
        id: spec.id,
        hostWallId,
        position,
        width: spec.width,
        height: spec.height,
        sillHeight: spec.sillHeight ?? 0,
        generatedBy: 'layout-v2',
        fillRef: undefined,
      });
      openingIds.add(spec.id);
    } catch (error) {
      if (!lenient) throw error;
      warnings.push(`opening ${spec.id} 未解析（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const filledOpenings = new Set([...doors, ...windows].map((item) => item.openingId));
  const fillIds = new Set([...doors, ...windows].map((item) => item.id));
  const claimOpening = (openingId: string, fillId: string) => {
    if (fillIds.has(fillId)) throw new Error(`门窗 id 重复：${fillId}`);
    if (filledOpenings.has(openingId)) throw new Error(`opening ${openingId} 只能安装一个门或窗`);
    filledOpenings.add(openingId);
    fillIds.add(fillId);
  };
  for (const spec of plan.doors ?? []) {
    try {
      const opening = openings.find((item) => item.id === spec.openingId);
      if (!opening) throw new Error(`door ${spec.id} 的 openingId ${spec.openingId} 不存在`);
      claimOpening(spec.openingId, spec.id);
      opening.fillRef = spec.id;
      doors.push({
        id: spec.id,
        openingId: spec.openingId,
        swing: spec.swing,
        leafCount: spec.leafCount ?? 1,
        analysisProperties: {
          ...catalogTypeIdForModel(
            spec.typeId ?? plan.openings?.find((o) => o.id === spec.openingId)?.typeId,
          ),
        },
      });
    } catch (error) {
      if (!lenient) throw error;
      warnings.push(`door ${spec.id} 未解析（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const spec of plan.windows ?? []) {
    try {
      const opening = openings.find((item) => item.id === spec.openingId);
      if (!opening) throw new Error(`window ${spec.id} 的 openingId ${spec.openingId} 不存在`);
      claimOpening(spec.openingId, spec.id);
      opening.fillRef = spec.id;
      windows.push({
        id: spec.id,
        openingId: spec.openingId,
        analysisProperties: catalogTypeIdForModel(spec.typeId),
      });
    } catch (error) {
      if (!lenient) throw error;
      warnings.push(`window ${spec.id} 未解析（已跳过）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const model: SpaceModel = {
    model: {
      schemaVersion: '1',
      revisionId,
      parentRevisionId: parent?.model.revisionId ?? null,
      units: catalog.units,
      origin: [...catalog.origin],
    },
    floor: structuredClone(catalog.floor),
    spaceTypes: [...types.values()],
    spaces: modelSpaces,
    walls,
    componentTypes: structuredClone(parent?.componentTypes),
    openings,
    doors,
    windows,
    fixedContext: structuredClone(parent?.fixedContext ?? []),
    externalContext: structuredClone(parent?.externalContext ?? []),
  };
  if (plan.floorHeight !== undefined) model.floor.height = plan.floorHeight * scale;

  if (!lenient) {
    warnings.push(...validateLayoutAccess(model, shared, plan.doors ?? []));

    if (requireFullCoverage) {
      const coverageErrors = validateLayoutCompleteness(model, true);
      if (coverageErrors.length) throw new Error(coverageErrors[0]);
    } else {
      const coverageErrors = validateLayoutCompleteness(model, false);
      for (const error of coverageErrors) if (error.includes('未分配')) warnings.push(error.replace(/^轮廓内仍有[^；]+；/, '尚有未分配面积；'));
    }
  }

  return { model, warnings, assumptions: plan.assumptions };
}
