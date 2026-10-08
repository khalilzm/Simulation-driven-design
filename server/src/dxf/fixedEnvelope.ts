import DxfParser, { type IEntity, type ILwpolylineEntity } from 'dxf-parser';
import { DXF_LAYERS, polygonGeometryError, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { closePolygon, pointInPolygonOrOnEdge, polygonArea, polygonEdgesContainedInPolygon, polygonsHaveAreaOverlap } from '../model/geometry';
import { validateStoredDesign } from '../model/designValidity';

const EPS = 1e-6;
type Metadata = Record<string, unknown>;
interface Part { entity: IEntity; id: string; ring: Vec2[]; data: Metadata }
interface Rectangle { points: [Vec2, Vec2]; width: number; thickness: number }
const distance = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const midpoint = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

function metadata(entity: IEntity): Metadata {
  if (entity.extendedData?.applicationName !== 'SDD_FIXED') return {};
  const strings = entity.extendedData.customStrings ?? [];
  if (strings.length !== 1) throw new Error(`${entity.layer} 的 SDD_FIXED 属性应为一个 JSON 对象`);
  try {
    const value: unknown = JSON.parse(strings[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Metadata;
  } catch { throw new Error(`${entity.layer} 的 SDD_FIXED 属性无法读取`); }
}

function ringOf(entity: IEntity, scale: number, origin: Vec2): Vec2[] {
  if (entity.type !== 'LWPOLYLINE' && entity.type !== 'POLYLINE') {
    throw new Error(`${entity.layer} 仅支持模型空间中的闭合 POLYLINE / LWPOLYLINE，收到 ${entity.type}`);
  }
  const poly = entity as ILwpolylineEntity;
  if (poly.inPaperSpace || Math.abs(poly.elevation ?? 0) > EPS
    || Math.abs(poly.extrusionDirectionX ?? 0) > EPS || Math.abs(poly.extrusionDirectionY ?? 0) > EPS
    || (poly.extrusionDirectionZ !== undefined && Math.abs(poly.extrusionDirectionZ - 1) > EPS)) {
    throw new Error(`${entity.layer} 需要位于模型空间 XY 平面的二维轮廓`);
  }
  if (!poly.vertices?.length || poly.vertices.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)
    || Math.abs(p.z ?? 0) > EPS || Math.abs(p.bulge ?? 0) > EPS)) {
    throw new Error(`${entity.layer} 含无效顶点、非平面坐标或圆弧边；目前只支持直线边`);
  }
  const points: Vec2[] = poly.vertices.map((p) => [p.x * scale - origin[0], p.y * scale - origin[1]]);
  if (!poly.shape && distance(points[0], points[points.length - 1]) > EPS) {
    throw new Error(`${entity.layer} 轮廓未闭合`);
  }
  const ring = closePolygon(points);
  const error = polygonGeometryError(ring);
  if (error) throw new Error(`${entity.layer}：${error}`);
  return ring;
}

/** Rectangular footprints become exact, butt-ended centerline walls, including rotated rectangles. */
function rectangle(part: Part): Rectangle {
  const p = part.ring.slice(0, -1);
  if (p.length !== 4) throw new Error(`${part.id} 必须是四角矩形占地，不能用包围盒代替原始构件`);
  const edges = p.map((a, i): Vec2 => [p[(i + 1) % 4][0] - a[0], p[(i + 1) % 4][1] - a[1]]);
  const lengths = edges.map((e) => Math.hypot(...e));
  for (let i = 0; i < 4; i++) {
    const next = edges[(i + 1) % 4];
    if (lengths[i] <= EPS || Math.abs(edges[i][0] * next[0] + edges[i][1] * next[1]) > EPS * lengths[i] * lengths[(i + 1) % 4]
      || Math.abs(lengths[i] - lengths[(i + 2) % 4]) > EPS) {
      throw new Error(`${part.id} 不是有效矩形占地`);
    }
  }
  if (Math.abs(lengths[0] - lengths[1]) < EPS) throw new Error(`${part.id} 为正方形，无法确定墙厚或洞口方向`);
  const i = lengths[0] > lengths[1] ? 0 : 1;
  let a = midpoint(p[i], p[(i + 3) % 4]);
  let b = midpoint(p[(i + 1) % 4], p[(i + 2) % 4]);
  if (b[0] < a[0] - EPS || (Math.abs(b[0] - a[0]) <= EPS && b[1] < a[1])) [a, b] = [b, a];
  return { points: [a, b], width: distance(a, b), thickness: lengths[(i + 1) % 4] };
}

export function parseFixedEnvelopeDxf(text: string, filename: string): SpaceModel {
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('请将图纸另存为 ASCII DXF');
  const drawing = new DxfParser().parseSync(text);
  if (!drawing) throw new Error('无法解析 DXF');
  const unit = drawing.header?.$INSUNITS;
  if (unit !== 4 && unit !== 6) throw new Error('DXF 必须声明单位：毫米（$INSUNITS=4）或米（6）');
  const scale = unit === 4 ? 0.001 : 1;
  const layers = new Set<string>(Object.values(DXF_LAYERS));
  // Do not silently omit fixed entities nested in blocks.
  for (const entity of drawing.entities) if (entity.type === 'INSERT') {
    const name = (entity as IEntity & { name: string }).name;
    if (layers.has(entity.layer) || drawing.blocks?.[name]?.entities?.some((e) => layers.has(e.layer))) {
      throw new Error('固定构件位于块中；请先炸开为模型空间闭合多段线');
    }
  }
  const entities = drawing.entities.filter((e) => layers.has(e.layer));
  const outlines = entities.filter((e) => e.layer === DXF_LAYERS.outline);
  if (outlines.length !== 1) throw new Error(`需要且仅允许 1 个 ${DXF_LAYERS.outline} 闭合轮廓，实际 ${outlines.length} 个`);
  const original = ringOf(outlines[0], scale, [0, 0]);
  const origin: Vec2 = [Math.min(...original.map((p) => p[0])), Math.min(...original.map((p) => p[1]))];
  const boundary = ringOf(outlines[0], scale, origin);
  const warnings: string[] = [];
  const ids = new Set<string>();
  const parts: Part[] = entities.filter((e) => e !== outlines[0]).map((entity, index) => {
    const data = metadata(entity);
    const id = data.id === undefined ? `${entity.layer}-${index + 1}` : String(data.id);
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new Error(`构件 ID 无效或重复：${id}`);
    ids.add(id);
    const ring = ringOf(entity, scale, origin);
    if (!polygonEdgesContainedInPolygon(ring, boundary)) throw new Error(`${id} 超出固定轮廓`);
    return { entity, data, id, ring };
  });
  const walls = parts.filter((p) => p.entity.layer === DXF_LAYERS.wall);
  const entrances = parts.filter((p) => p.entity.layer === DXF_LAYERS.entrance);
  const windows = parts.filter((p) => p.entity.layer === DXF_LAYERS.window);
  if (!walls.length || !entrances.length) throw new Error('住宅底图需要 FIXED_LOAD_BEARING 承重墙及 FIXED_ENTRANCE 入户口');
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    if (polygonsHaveAreaOverlap(parts[i].ring, parts[j].ring)) throw new Error(`${parts[i].id} 与 ${parts[j].id} 占地重叠；墙体须扣除门窗洞口`);
  }
  const mm = (part: Part, key: string, fallback: number, zero = false): number => {
    const value = part.data[key];
    if (value === undefined) {
      warnings.push(`${part.id} 未声明 ${key}，采用 ${fallback * 1000} mm`);
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0)) throw new Error(`${part.id}.${key} 无效`);
    return value / 1000;
  };
  const wallParts = walls.map((p) => ({ part: p, rect: rectangle(p), height: mm(p, 'height_mm', 2.8) }));
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId: 'rev-0000', parentRevisionId: null, units: 'm', origin,
      dxfSource: { filename, sourceUnits: unit === 4 ? 'mm' : 'm', widthM: Math.max(...boundary.map((p) => p[0])),
        depthM: Math.max(...boundary.map((p) => p[1])), areaM2: polygonArea(boundary),
        counts: { outlines: 1, loadBearingWalls: walls.length, entrances: entrances.length, windows: windows.length }, warnings } },
    floor: { boundary, elevation: 0, height: Math.max(...wallParts.map((p) => p.height)), topObstruction: true, bottomObstruction: true },
    spaces: [], walls: [], openings: [], doors: [], windows: [], fixedContext: [], externalContext: [],
  };
  const makeWall = (id: string, rect: Rectangle, height: number, sourceId: string): Wall => ({
    id, geometry: { type: 'polyline', points: rect.points }, thickness: rect.thickness, height, fixed: true, role: 'structural',
    analysisProperties: { dxfSourceId: sourceId },
  });
  model.walls = wallParts.map(({ part, rect, height }) => makeWall(part.id, rect, height, part.id));
  for (const part of [...entrances, ...windows]) {
    const rect = rectangle(part);
    const adjacent = rect.points.map((point) => wallParts.filter((w) => Math.abs(w.rect.thickness - rect.thickness) < EPS
      && pointInPolygonOrOnEdge(point, w.part.ring)));
    if (adjacent.some((list) => list.length !== 1)) throw new Error(`${part.id} 两端必须连接同厚度的承重墙，无法建立门窗宿主`);
    const height = adjacent[0][0].height;
    if (Math.abs(height - adjacent[1][0].height) > EPS) throw new Error(`${part.id} 两侧墙高不一致`);
    const isDoor = part.entity.layer === DXF_LAYERS.entrance;
    const openingHeight = mm(part, 'height_mm', isDoor ? 2.1 : 1.2);
    const sill = isDoor ? 0 : mm(part, 'sill_mm', 0.9, true);
    if (sill + openingHeight > height + EPS) throw new Error(`${part.id} 洞口顶部超过墙高`);
    if (part.data.width_mm !== undefined && Math.abs(mm(part, 'width_mm', rect.width) - rect.width) > EPS) throw new Error(`${part.id} 标注宽度与洞口几何不一致`);
    const hostId = `dxf-host-${part.id}`, openingId = `dxf-opening-${part.id}`;
    if (ids.has(hostId) || ids.has(openingId)) throw new Error(`${part.id} 的宿主 ID 与图纸构件冲突`);
    // A host spans exactly the already-cut footprint. Its opening removes the full planar width,
    // while 3D retains the sill and lintel; no solid wall is added across the entrance.
    model.walls.push(makeWall(hostId, rect, height, part.id));
    model.openings.push({ id: openingId, hostWallId: hostId, position: rect.width / 2, width: rect.width, height: openingHeight, sillHeight: sill, fillRef: part.id });
    if (isDoor) {
      const door: SpaceModel['doors'][number] = { id: part.id, openingId, swing: 'none', analysisProperties: { fixed: true, entrance: true } };
      // A matching swing arc on SYMBOLS is the only source for hinge/opening direction.
      const arc = drawing.entities.find((e) => {
        if (e.type !== 'ARC' || e.layer !== 'SYMBOLS') return false;
        const a = e as IEntity & { center: { x: number; y: number }; radius: number };
        const c: Vec2 = [a.center.x * scale - origin[0], a.center.y * scale - origin[1]];
        return Math.abs(a.radius * scale - rect.width) < EPS && rect.points.some((p) => distance(p, c) < EPS);
      }) as (IEntity & { center: { x: number; y: number }; startAngle: number; endAngle: number }) | undefined;
      if (arc) {
        const c: Vec2 = [arc.center.x * scale - origin[0], arc.center.y * scale - origin[1]];
        const angle = arc.startAngle + ((arc.endAngle - arc.startAngle + Math.PI * 2) % (Math.PI * 2)) / 2;
        const [a, b] = rect.points;
        const side = -(b[1] - a[1]) * Math.cos(angle) + (b[0] - a[0]) * Math.sin(angle);
        door.swing = 'left'; door.hinge = distance(c, a) < EPS ? 'start' : 'end'; door.opensTo = side > 0 ? 'left' : 'right';
      } else warnings.push(`${part.id} 未提供匹配门弧，仅显示入户洞口，不推断开启方向`);
      model.doors.push(door);
    } else model.windows.push({ id: part.id, openingId, analysisProperties: { fixed: true } });
  }
  const ignoredLayers = [...new Set(drawing.entities.filter((e) => !layers.has(e.layer) && !['SYMBOLS', 'ANNOTATION'].includes(e.layer)).map((e) => e.layer))];
  if (ignoredLayers.length) warnings.push(`未导入其他图层：${ignoredLayers.join('、')}`);
  const validation = validateStoredDesign(model);
  if (!validation.valid) throw new Error(validation.errors.join('；'));
  return model;
}
