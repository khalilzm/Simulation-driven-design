import { pointInOrOnPolygon, polygonGeometryError } from '@sdd/shared';
import type { Vec2 } from '@sdd/shared';
import { closePolygon, polygonArea } from '../geometry/polygon';
import { cleanRing, geometryArea, intersection, outsideArea, polygons } from '../geometry/regions';

const OUTSIDE_EPS_M2 = 1e-6;

function formatPoint(p: Vec2): string {
  return `[${p[0].toFixed(3)}, ${p[1].toFixed(3)}]`;
}

/** 列出落在 floor 外的 space 顶点（不含闭合重复点）。 */
export function verticesOutsideFloor(boundary: Vec2[], floorBoundary: Vec2[]): Vec2[] {
  const floor = closePolygon(floorBoundary, 0);
  return closePolygon(boundary, 0).slice(0, -1).filter((point) => !pointInOrOnPolygon(point, floor));
}

/** 与 floor 求交，取面积最大的外环作为裁切结果。 */
export function clipSpaceBoundaryToFloor(boundary: Vec2[], floorBoundary: Vec2[]): Vec2[] | null {
  const clipped = intersection([closePolygon(boundary, 0)], [closePolygon(floorBoundary, 0)]);
  const parts = polygons(clipped);
  if (!parts.length) return null;
  let best: Vec2[] | null = null;
  let bestArea = 0;
  for (const polygon of parts) {
    const ring = cleanRing(polygon[0]);
    const area = polygonArea(ring);
    if (area > bestArea && !polygonGeometryError(ring)) {
      best = ring;
      bestArea = area;
    }
  }
  return best;
}

/**
 * 轻微越界时裁切到固定轮廓并写 warning，避免整案失败；无法裁切时抛出带坐标提示的错误。
 */
export function ensureSpaceInsideFloor(
  space: { id: string; usage: string; boundary: Vec2[] },
  floorBoundary: Vec2[],
  scale: number,
  warnings: string[],
): void {
  let boundary = cleanRing(space.boundary);
  if (polygonGeometryError(boundary)) throw new Error(`space ${space.id} ${polygonGeometryError(boundary)}`);
  const outside = outsideArea(boundary, floorBoundary) / scale ** 2;
  if (outside <= OUTSIDE_EPS_M2) {
    space.boundary = boundary;
    return;
  }
  const bad = verticesOutsideFloor(boundary, floorBoundary);
  const hint = bad.length
    ? `越界顶点：${bad.slice(0, 4).map(formatPoint).join('、')}${bad.length > 4 ? ' 等' : ''}；合法范围见提示词 floor.boundary（勿按 bbox 外扩）`
    : '部分边线穿出固定轮廓；顶点须全部落在 floor.boundary 内';
  const clipped = clipSpaceBoundaryToFloor(boundary, floorBoundary);
  if (!clipped || polygonGeometryError(clipped)) {
    throw new Error(`${space.id} 超出固定轮廓且无法自动裁切（${hint}）`);
  }
  const clippedArea = polygonArea(clipped) / scale ** 2;
  const originalArea = polygonArea(boundary) / scale ** 2;
  if (clippedArea < OUTSIDE_EPS_M2) {
    throw new Error(`${space.id} 超出固定轮廓，裁切后无有效面积（${hint}）`);
  }
  space.boundary = clipped;
  const lost = Math.max(0, originalArea - clippedArea);
  warnings.push(
    `${space.usage}（${space.id}）超出固定轮廓约 ${outside.toFixed(3)} m²，已自动裁切到轮廓内${lost > OUTSIDE_EPS_M2 ? `（裁掉 ${lost.toFixed(3)} m²）` : ''}；${hint}`,
  );
}

export { OUTSIDE_EPS_M2 };
