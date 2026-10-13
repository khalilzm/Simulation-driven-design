import { polygonGeometryError, type Floor, type SpaceModel, type Unit, type Vec2 } from '@sdd/shared';
import { closePolygon } from '../geometry/polygon';

/** 布局编译上下文：固定轮廓与父方案，不含 x 条带 region 分解。 */
export interface LayoutContext {
  floor: Floor;
  origin: Vec2;
  units: Unit;
  parent?: SpaceModel;
  /** 草图直读模式：不补闭合、不校验几何，原样保留大模型返回的轮廓。 */
  lenient?: boolean;
}

export function createLayoutContext(outline: string, parent?: SpaceModel, lenient = false): LayoutContext {
  const input = JSON.parse(outline) as { boundary: Vec2[]; origin: Vec2; units?: Unit };
  const boundary = lenient ? input.boundary : closePolygon(input.boundary, 0);
  if (!lenient) {
    const error = polygonGeometryError(boundary);
    if (error) throw new Error(`固定轮廓无效：${error}`);
  }
  const units = input.units ?? 'm';
  const scale = units === 'mm' ? 1000 : 1;
  return {
    floor: parent
      ? { ...structuredClone(parent.floor), boundary }
      : { boundary, elevation: 0, height: 3 * scale, topObstruction: false, bottomObstruction: false },
    origin: [...input.origin],
    units,
    parent,
    ...(lenient ? { lenient } : {}),
  };
}

/** 外轮廓边列表，供提示词引用（segment 两端点，本地坐标）。 */
export function floorEdgeSegments(boundary: Vec2[]): [Vec2, Vec2][] {
  const ring = closePolygon(boundary, 0);
  const segments: [Vec2, Vec2][] = [];
  for (let i = 0; i + 1 < ring.length; i++) segments.push([ring[i], ring[i + 1]]);
  return segments;
}

export function floorCornerVertices(boundary: Vec2[]): Vec2[] {
  return closePolygon(boundary, 0).slice(0, -1);
}
