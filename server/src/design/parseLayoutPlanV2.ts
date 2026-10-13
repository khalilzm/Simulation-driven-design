import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../geometry/polygon';
import { segmentOverlap, sharedSegments } from '../geometry/regions';
import type { BoundaryKind, LayoutBoundarySpec, LayoutSpaceSpec } from './layoutPlanTypes';
import { segmentCoveredBy, splitBoundarySegment } from './layoutWalls';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('布局必须是 JSON 对象');
  return value as Record<string, unknown>;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} 必须是非空字符串数组（数组本身可空）`);
  }
  return value as string[];
}

function vec2(raw: unknown, field: string): Vec2 {
  if (!Array.isArray(raw) || raw.length !== 2 || !Number.isFinite(raw[0]) || !Number.isFinite(raw[1])) {
    throw new Error(`${field} 必须是 [x,y] 数值对`);
  }
  return [Number(raw[0]), Number(raw[1])];
}

function boundaryRing(raw: unknown, field: string, lenient = false): Vec2[] {
  if (!Array.isArray(raw) || raw.length < 3) throw new Error(`${field} 至少需要 3 个顶点`);
  const points = raw.map((point, i) => vec2(point, `${field}[${i}]`));
  return lenient ? points : closePolygon(points, 0);
}

function normalizeDoorSwing(doorId: string, raw: unknown): 'left' | 'right' | 'none' {
  if (raw === 'left' || raw === 'right' || raw === 'none') return raw;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === 'inward' || s === 'in') return 'left';
    if (s === 'outward' || s === 'out') return 'right';
  }
  throw new Error(`${doorId}.swing 只能是 left/right/none`);
}

export function isLayoutPlanV2(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const root = raw as Record<string, unknown>;
  if ('allocations' in root || 'splits' in root) {
    throw new Error('layout.json 不再支持 allocations/regionIds/splits；请改用 schemaVersion 2 的 spaces 与 boundaries');
  }
  if (root.schemaVersion !== 2) throw new Error('layout.json 必须包含 schemaVersion: 2');
  return true;
}

export function parseLayoutPlanV2(raw: unknown, lenient = false): import('./layoutPlanTypes').LayoutPlanV2 {
  const root = record(raw);
  if (root.schemaVersion !== 2) throw new Error('layout.json 必须包含 schemaVersion: 2');
  for (const field of ['model', 'floor', 'walls', 'allocations', 'splits']) {
    if (field in root) throw new Error(`不要输出 ${field}；只提交 schemaVersion 2 的 spaces、boundaries、openings 等`);
  }
  if (!Array.isArray(root.spaces) || !root.spaces.length || root.spaces.length > 64) {
    throw new Error('spaces 需要包含 1～64 个空间');
  }
  const spaces: LayoutSpaceSpec[] = root.spaces.map((rawSpace) => {
    const item = record(rawSpace);
    if (typeof item.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(item.id)) {
      throw new Error('space.id 须为字母开头的英文标识');
    }
    if (item.id === 'outside') throw new Error('outside 为室外边界保留标识，不能作为空间 ID');
    if (typeof item.usage !== 'string' || !item.usage.trim()) throw new Error(`${item.id} 缺少 usage`);
    if (typeof item.enclosed !== 'boolean') throw new Error(`${item.id}.enclosed 必须是布尔值`);
    for (const key of ['targetArea', 'minArea']) {
      if (item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0)) {
        throw new Error(`${item.id}.${key} 必须是非负平方米数`);
      }
    }
    return {
      id: item.id,
      usage: item.usage.trim(),
      enclosed: item.enclosed,
      boundary: boundaryRing(item.boundary, `${item.id}.boundary`, lenient),
      targetArea: item.targetArea as number | undefined,
      minArea: item.minArea as number | undefined,
    };
  });
  const parseBoundaries = (): LayoutBoundarySpec[] => {
    if (root.boundaries === undefined) return [];
    if (!Array.isArray(root.boundaries)) throw new Error('boundaries 必须是数组');
    return root.boundaries.map((rawBoundary) => {
      const item = record(rawBoundary);
      if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('boundary.id 必须是非空字符串');
      if (item.kind !== 'wall' && item.kind !== 'open') throw new Error(`${item.id}.kind 只能是 wall 或 open`);
      if (!Array.isArray(item.segment) || item.segment.length !== 2) throw new Error(`${item.id}.segment 必须是两个端点`);
      if (typeof item.leftSpaceId !== 'string' || typeof item.rightSpaceId !== 'string') {
        throw new Error(`${item.id} 必须指定 leftSpaceId 与 rightSpaceId`);
      }
      return {
        id: item.id,
        segment: [vec2(item.segment[0], `${item.id}.segment[0]`), vec2(item.segment[1], `${item.id}.segment[1]`)] as [Vec2, Vec2],
        kind: item.kind as BoundaryKind,
        leftSpaceId: item.leftSpaceId,
        rightSpaceId: item.rightSpaceId,
      };
    });
  };
  const parseOpenings = () => {
    if (root.openings === undefined) return [];
    if (!Array.isArray(root.openings)) throw new Error('openings 必须是数组');
    return root.openings.map((rawOpening) => {
      const item = record(rawOpening);
      if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('opening.id 必须是非空字符串');
      const positionRaw = item.position;
      if (typeof positionRaw === 'number') {
        if (!Number.isFinite(positionRaw) || positionRaw < 0) throw new Error(`${item.id}.position 必须是非负弧长`);
      } else if (positionRaw !== 'start' && positionRaw !== 'center' && positionRaw !== 'end') {
        throw new Error(`${item.id}.position 必须是 start/center/end 或非负弧长`);
      }
      for (const key of ['width', 'height'] as const) {
        const raw = item[key];
        if (raw === undefined) continue;
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
          throw new Error(`${item.id}.${key} 必须是正数`);
        }
      }
      if (item.typeId !== undefined && typeof item.typeId !== 'string') {
        throw new Error(`${item.id}.typeId 必须是字符串`);
      }
      if (item.hostBoundaryId !== undefined && typeof item.hostBoundaryId !== 'string') {
        throw new Error(`${item.id}.hostBoundaryId 必须是字符串`);
      }
      if (item.hostWallId !== undefined && typeof item.hostWallId !== 'string') {
        throw new Error(`${item.id}.hostWallId 必须是字符串`);
      }
      if (!item.hostBoundaryId && !item.hostWallId) throw new Error(`${item.id} 需要 hostBoundaryId 或 hostWallId`);
      if (item.hostBoundaryId && item.hostWallId) throw new Error(`${item.id} 只能指定一种宿主引用`);
      if (item.sillHeight !== undefined && (typeof item.sillHeight !== 'number'
        || !Number.isFinite(item.sillHeight) || item.sillHeight < 0)) {
        throw new Error(`${item.id}.sillHeight 必须是非负数`);
      }
      return {
        id: item.id,
        hostBoundaryId: item.hostBoundaryId as string | undefined,
        hostWallId: item.hostWallId as string | undefined,
        position: positionRaw as number | 'start' | 'center' | 'end',
        width: typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0 ? item.width : 0,
        height: typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0 ? item.height : 0,
        sillHeight: item.sillHeight as number | undefined,
        typeId: typeof item.typeId === 'string' ? item.typeId : undefined,
      };
    });
  };
  const parseDoors = () => {
    if (root.doors === undefined) return [];
    if (!Array.isArray(root.doors)) throw new Error('doors 必须是数组');
    return root.doors.map((rawDoor) => {
      const item = record(rawDoor);
      if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('door.id 必须是非空字符串');
      if (typeof item.openingId !== 'string') throw new Error(`${item.id} 缺少 openingId`);
      const swing = item.swing !== undefined ? normalizeDoorSwing(item.id as string, item.swing) : undefined;
      if (item.typeId !== undefined && typeof item.typeId !== 'string') throw new Error(`${item.id}.typeId 必须是字符串`);
      if (item.connects !== undefined) {
        if (!Array.isArray(item.connects) || item.connects.length !== 2
          || item.connects.some((id) => typeof id !== 'string')) {
          throw new Error(`${item.id}.connects 必须是两个 spaceId`);
        }
      }
      return {
        id: item.id,
        openingId: item.openingId,
        swing: swing ?? 'left',
        leafCount: item.leafCount as 1 | 2 | undefined,
        connects: item.connects as [string, string] | undefined,
        typeId: typeof item.typeId === 'string' ? item.typeId : undefined,
      };
    });
  };
  const parseWindows = () => {
    if (root.windows === undefined) return [];
    if (!Array.isArray(root.windows)) throw new Error('windows 必须是数组');
    return root.windows.map((rawWindow) => {
      const item = record(rawWindow);
      if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('window.id 必须是非空字符串');
      if (typeof item.openingId !== 'string') throw new Error(`${item.id} 缺少 openingId`);
      if (item.typeId !== undefined && typeof item.typeId !== 'string') throw new Error(`${item.id}.typeId 必须是字符串`);
      return {
        id: item.id,
        openingId: item.openingId,
        typeId: typeof item.typeId === 'string' ? item.typeId : undefined,
      };
    });
  };
  if (root.floorHeight !== undefined && (typeof root.floorHeight !== 'number' || !Number.isFinite(root.floorHeight) || root.floorHeight <= 0)) {
    throw new Error('floorHeight 必须是正数（米）');
  }
  if (root.wallThickness !== undefined && (typeof root.wallThickness !== 'number' || !Number.isFinite(root.wallThickness) || root.wallThickness <= 0)) {
    throw new Error('wallThickness 必须是正数（米）');
  }
  return {
    schemaVersion: 2,
    spaces,
    boundaries: parseBoundaries(),
    openings: parseOpenings(),
    doors: parseDoors(),
    windows: parseWindows(),
    assumptions: strings(root.assumptions ?? [], 'assumptions'),
    unmetRequirements: strings(root.unmetRequirements ?? [], 'unmetRequirements'),
    floorHeight: root.floorHeight as number | undefined,
    wallThickness: root.wallThickness as number | undefined,
  };
}

export function segmentKey(a: Vec2, b: Vec2): string {
  const points = [a, b].map((p) => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))] as Vec2);
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return `${points[0][0]},${points[0][1]}|${points[1][0]},${points[1][1]}`;
}

/** 合并显式 boundaries 与按 enclosed 推断的共享边。 */
export function resolveSharedBoundaries(spaces: LayoutSpaceSpec[], explicit: LayoutBoundarySpec[]): LayoutBoundarySpec[] {
  const byKey = new Map<string, LayoutBoundarySpec>();
  for (const boundary of explicit) {
    byKey.set(segmentKey(boundary.segment[0], boundary.segment[1]), boundary);
  }
  for (let i = 0; i < spaces.length; i++) {
    for (let j = i + 1; j < spaces.length; j++) {
      const left = spaces[i], right = spaces[j];
      const overrides = explicit.filter((boundary) => [boundary.leftSpaceId, boundary.rightSpaceId].includes(left.id)
        && [boundary.leftSpaceId, boundary.rightSpaceId].includes(right.id));
      const parts = sharedSegments(left.boundary, right.boundary)
        .flatMap(([a, b]) => splitBoundarySegment(a, b, overrides.map((boundary) => boundary.segment)));
      for (const [a, b] of parts) {
        const key = segmentKey(a, b);
        if (overrides.some((boundary) => segmentCoveredBy(a, b, [boundary.segment]))) continue;
        const kind: BoundaryKind = left.enclosed || right.enclosed ? 'wall' : 'open';
        byKey.set(key, {
          id: `auto-${key}`,
          segment: [a, b],
          kind,
          leftSpaceId: left.id,
          rightSpaceId: right.id,
        });
      }
    }
  }
  return [...byKey.values()];
}

export function validateExplicitBoundaries(
  spaces: LayoutSpaceSpec[],
  boundaries: LayoutBoundarySpec[],
  floorBoundary: Vec2[] = [],
): string[] {
  const ids = new Set([...spaces.map((space) => space.id), 'outside']);
  const boundaryIds = new Set<string>();
  const errors: string[] = [];
  for (const boundary of boundaries) {
    if (boundaryIds.has(boundary.id)) errors.push(`boundary id 重复：${boundary.id}`);
    boundaryIds.add(boundary.id);
    if (boundary.leftSpaceId === boundary.rightSpaceId) errors.push(`boundary ${boundary.id} 两侧必须不同`);
    if (!ids.has(boundary.leftSpaceId)) errors.push(`boundary ${boundary.id} 的 leftSpaceId ${boundary.leftSpaceId} 不存在`);
    if (!ids.has(boundary.rightSpaceId)) errors.push(`boundary ${boundary.id} 的 rightSpaceId ${boundary.rightSpaceId} 不存在`);
    const exterior = boundary.leftSpaceId === 'outside' || boundary.rightSpaceId === 'outside';
    if (exterior && boundary.kind !== 'wall') errors.push(`外边界 ${boundary.id} 应设为 wall，通行口请使用 opening`);
    const left = boundary.leftSpaceId === 'outside' ? { boundary: floorBoundary }
      : spaces.find((space) => space.id === boundary.leftSpaceId);
    const right = boundary.rightSpaceId === 'outside' ? { boundary: floorBoundary }
      : spaces.find((space) => space.id === boundary.rightSpaceId);
    if (left && right) {
      const shared = sharedSegments(left.boundary, right.boundary);
      const ok = segmentCoveredBy(boundary.segment[0], boundary.segment[1], shared);
      if (!ok) errors.push(`boundary ${boundary.id} 的 segment 不是 ${boundary.leftSpaceId} 与 ${boundary.rightSpaceId} 的共享边`);
    }
    for (const other of boundaries.slice(0, boundaries.indexOf(boundary))) {
      if (segmentOverlap(...boundary.segment, ...other.segment)) errors.push(`boundary ${boundary.id} 与 ${other.id} 重叠`);
    }
  }
  return errors;
}
