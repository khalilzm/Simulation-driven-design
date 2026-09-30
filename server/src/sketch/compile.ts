import { diff } from 'martinez-polygon-clipping';
import { pointInOrOnPolygon, polygonGeometryError, type SketchCompilation, type SketchExtraction, type SketchSource, type SpaceModel, type Vec2 } from '@sdd/shared';
import { cleanRing, decomposeRegions, polygons } from '../design/regionGeometry';
import { along, buildSketchTopology, distance, length, signedArea } from './topology';

const COLORS = ['#A8C8F0', '#98D4B8', '#FFE4A8', '#C8B8E8', '#FFB878', '#88C8E8'];

export function compileSketch(input: SketchExtraction, source: SketchSource, revisionId: string): SketchCompilation {
  // Snap tolerance in source pixels. Hand-drawn strokes carry several px of endpoint
  // jitter (gaps of 2–5px between walls that should meet); a sub-pixel tolerance never
  // closes those, so rooms fail to form and the plan collapses downstream.
  const tolerance = Math.min(12, Math.max(4, Math.min(source.width, source.height) * 0.01));
  const topology = buildSketchTopology(input, tolerance);
  const { normalized, issues, adjustments } = topology;
  const mapping: Record<string, string[]> = {};
  const issue = (id: string, severity: 'error' | 'review' | 'info', message: string, objectId?: string, point?: Vec2) =>
    issues.push({ id, severity, message, objectId, point });
  const scales = input.dimensions.map((d) => d.lengthM / distance(d.points[0], d.points[1])).sort((a, b) => a - b);
  const calibrated = scales.length > 0;
  const metersPerPixel = scales.length ? scales[Math.floor(scales.length / 2)] : 10 / Math.max(source.width, source.height);
  if (!calibrated) issue('scale-missing', 'review', '没有实际尺寸依据；当前为比例预览，请选取一面墙输入实长后再用于分析');
  for (const d of input.dimensions) {
    const s = d.lengthM / distance(d.points[0], d.points[1]);
    if (Math.abs(s / metersPerPixel - 1) > 0.05) issue(`scale-${d.id}`, 'review', '尺寸标注比例相差超过 5%，请核对对应端点或校正透视', d.id);
    mapping[d.id] = ['model.units'];
  }
  const convert = ([x, y]: Vec2): Vec2 => [x * metersPerPixel, (source.height - y) * metersPerPixel];
  const convertBoundary = (ring: Vec2[]): Vec2[] => {
    const boundary = ring.map(convert);
    // Y reflection reverses winding. Horizontal model faces must point toward +Z.
    return signedArea(boundary) < 0 ? boundary.reverse() : boundary;
  };
  const result: SketchCompilation = { normalized, issues, adjustments, mapping, metersPerPixel, calibrated };
  const faces = topology.faces.map(cleanRing).filter((ring, index) => {
    const error = polygonGeometryError(ring);
    if (error) issue(`face-${index}`, 'review', `区域拓扑无效：${error}`);
    return !error;
  });
  const height = input.heightM ?? 3;
  if (input.heightM === null) issue('height-default', 'review', '图中没有层高，预览暂用 3 米；请确认尺寸假设');
  // Floor = axis-aligned envelope of all wall geometry, not the union of closed rooms.
  // Hand-drawn plans are often open (porch/carport/L-shape), so the slab must not require
  // a closed wall loop. unionRings(faces) collapses the footprint to whichever rooms
  // happened to close, then flags every other wall as "outside floor".
  const wallPoints = normalized.walls.flatMap((w) => w.points);
  if (!wallPoints.length) return result;
  const xs = wallPoints.map((p) => p[0]);
  const ys = wallPoints.map((p) => p[1]);
  const floorBoundary = convertBoundary([
    [Math.min(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.min(...ys)],
    [Math.max(...xs), Math.max(...ys)],
    [Math.min(...xs), Math.max(...ys)],
    [Math.min(...xs), Math.min(...ys)],
  ]);
  const model: SpaceModel = {
    model: { schemaVersion: '1', revisionId, parentRevisionId: null, units: 'm', origin: [0, 0], sketchId: source.id, sketchStatus: 'needs_review' },
    floor: { boundary: floorBoundary, elevation: 0, height, topObstruction: false, bottomObstruction: false },
    walls: [], openings: [], doors: [], windows: [], spaces: [], spaceTypes: [], fixedContext: [], externalContext: [],
  };
  for (const wall of normalized.walls) {
    if (wall.thicknessPx === null && wall.thicknessM == null) issue(`thickness-${wall.id}`, 'review', '墙厚不明，预览暂用 0.12 米', wall.id, wall.points[0]);
    model.walls.push({ id: wall.id, geometry: { type: 'polyline', points: wall.points.map(convert) },
      thickness: wall.thicknessM ?? (wall.thicknessPx === null ? 0.12 : wall.thicknessPx * metersPerPixel), height, fixed: false, role: 'unknown',
      analysisProperties: { sketchId: source.id, sourceWallId: wall.id } });
  }
  for (const [id, target] of topology.aliases) mapping[id] = [target.id];
  for (const opening of input.openings) {
    mapping[opening.id] = [];
    const alias = topology.aliases.get(opening.wallId);
    const host = normalized.walls.find((w) => w.id === alias?.id);
    if (!host || !alias) { issue(`host-${opening.id}`, 'review', `门窗宿主 ${opening.wallId} 不存在`, opening.id); continue; }
    const hostLength = length(host.points);
    const position = (alias.reversed ? 1 - opening.position : opening.position) * hostLength;
    const point = along(host.points, position);
    if (position - opening.widthPx / 2 < -1e-5 || position + opening.widthPx / 2 > hostLength + 1e-5) {
      issue(`range-${opening.id}`, 'review', '洞口超出所属墙线', opening.id, point);
    }
    let accumulated = 0, crossesCorner = false;
    for (let i = 1; i + 1 < host.points.length; i++) {
      accumulated += distance(host.points[i - 1], host.points[i]);
      if (accumulated > position - opening.widthPx / 2 + 1e-5 && accumulated < position + opening.widthPx / 2 - 1e-5) {
        const a = host.points[i - 1], b = host.points[i], c = host.points[i + 1];
        if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-5) crossesCorner = true;
      }
    }
    if (crossesCorner) { issue(`corner-${opening.id}`, 'review', '洞口跨越墙体转角', opening.id, point); }
    const start = along(host.points, position - opening.widthPx / 2), end = along(host.points, position + opening.widthPx / 2);
    const dx = end[0] - start[0], dy = end[1] - start[1];
    let crossesJunction = false;
    for (const other of normalized.walls) {
      if (other.id === host.id) continue;
      for (let i = 0; i + 1 < other.points.length; i++) {
        const a = other.points[i], b = other.points[i + 1], ex = b[0] - a[0], ey = b[1] - a[1];
        const det = dx * ey - dy * ex;
        if (Math.abs(det) < 1e-7) continue;
        const t = ((a[0] - start[0]) * ey - (a[1] - start[1]) * ex) / det;
        const u = ((a[0] - start[0]) * dy - (a[1] - start[1]) * dx) / det;
        if (t > 1e-6 && t < 1 - 1e-6 && u >= -1e-6 && u <= 1 + 1e-6) crossesJunction = true;
      }
    }
    if (crossesJunction) { issue(`junction-${opening.id}`, 'review', '洞口跨越另一面墙的连接点', opening.id, point); }
    if (opening.kind === 'unknown') { issue(`kind-${opening.id}`, 'review', '开口类型不明，保留识别记录，暂不生成构件', opening.id, point); continue; }
    const sill = opening.sillHeightM ?? (opening.kind === 'window' ? 0.9 : 0);
    const openingHeight = opening.heightM ?? (opening.kind === 'window' ? 1.2 : 2.1);
    if (opening.heightM === null || (opening.kind === 'window' && opening.sillHeightM === null)) {
      issue(`dimensions-${opening.id}`, 'review', `开口高度或窗台高度不明，预览暂用高 ${openingHeight} 米、底高 ${sill} 米`, opening.id, point);
    }
    if (sill + openingHeight > height + 1e-6) { issue(`height-${opening.id}`, 'review', '洞口顶部超过墙高', opening.id, point); }
    const pos = position * metersPerPixel, width = opening.widthPx * metersPerPixel;
    if (model.openings.some((o) => o.hostWallId === host.id && Math.abs(o.position - pos) < (o.width + width) / 2 - 1e-6)) {
      issue(`overlap-${opening.id}`, 'review', '与同一面墙上的其他洞口重叠', opening.id, point);
    }
    model.openings.push({ id: opening.id, hostWallId: host.id, position: pos, width, height: openingHeight, sillHeight: sill,
      fillRef: opening.kind === 'passage' ? undefined : `fill-${opening.id}` });
    mapping[opening.id] = [opening.id];
    if (opening.kind === 'door') {
      if (!opening.hinge || !opening.opensTo || !opening.leafCount) issue(`motion-${opening.id}`, 'review', '门扇数量或开启方向不明，预览仅显示开口', opening.id, point);
      const hinge = alias.reversed ? (opening.hinge === 'start' ? 'end' : 'start') : opening.hinge ?? 'start';
      // Image Y is downward: reflection flips the left/right normal; reversed aliases flip again.
      const opensTo = alias.reversed ? opening.opensTo ?? 'left' : opening.opensTo === 'left' ? 'right' : 'left';
      model.doors.push({ id: `fill-${opening.id}`, openingId: opening.id, swing: opening.hinge && opening.opensTo ? 'left' : 'none',
        hinge, opensTo, leafCount: opening.leafCount ?? 1, analysisProperties: { sourceOpeningId: opening.id } });
    } else if (opening.kind === 'window') model.windows.push({ id: `fill-${opening.id}`, openingId: opening.id, analysisProperties: { sourceOpeningId: opening.id } });
  }
  const labelsByFace = faces.map(() => [] as typeof input.labels);
  const dimensionLabelsByFace = faces.map(() => [] as typeof input.labels);
  for (const label of input.labels) {
    mapping[label.id] = [];
    const candidates = faces.map((ring, index) => ({ ring, index })).filter(({ ring }) => pointInOrOnPolygon(label.point, ring));
    candidates.sort((a, b) => Math.abs(signedArea(a.ring)) - Math.abs(signedArea(b.ring)));
    if (label.kind === 'dimension') {
      if (candidates.length) dimensionLabelsByFace[candidates[0].index].push(label);
      continue;
    }
    if (!candidates.length) { issue(`label-${label.id}`, 'review', '文字标注不在任何闭合区域内（开放区域，未生成房间）', label.id, label.point); continue; }
    if (candidates.length > 1 && !candidates[0].ring.every((p) => pointInOrOnPolygon(p, candidates[1].ring))) {
      issue(`label-boundary-${label.id}`, 'review', '标注锚点落在多个区域的共享边上，请移入所属区域', label.id, label.point);
    }
    labelsByFace[candidates[0].index].push(label);
  }
  const spaceIdsByFace: string[][] = faces.map(() => []);
  faces.forEach((face, index) => {
    const labels = labelsByFace[index];
    if (!labels.length) issue(`unlabelled-${index}`, 'review', '闭合区域没有文字标注，请确认功能用途');
    if (labels.length > 1) issue(`ambiguous-${index}`, 'review', '一个区域含有多个功能标注；请核对开放区分界', labels[0].id, labels[0].point);
    // Disconnected inner loops form holes in the surrounding face, not overlapping rooms.
    let region: Parameters<typeof diff>[0] = [face];
    for (const other of faces) {
      if (other === face || Math.abs(signedArea(other)) >= Math.abs(signedArea(face))) continue;
      if (other.slice(0, -1).every((p) => pointInOrOnPolygon(p, face))) region = diff(region, [other]) ?? [];
    }
    const pieces = polygons(region).flatMap((polygon) => polygon.length === 1 ? [cleanRing(polygon[0])] : decomposeRegions([polygon]));
    const usage = labels.map((l) => l.text).join(' / ') || `待标注区域 ${index + 1}`;
    const typeLabel = labels.map((l) => l.usage ?? l.text).join(' / ') || usage;
    const typeId = `sketch-type-${index + 1}`;
    model.spaceTypes!.push({ id: typeId, label: typeLabel, color: COLORS[index % COLORS.length] });
    const allocationId = labels[0] ? `space-${labels[0].id}` : `space-unlabelled-${index + 1}`;
    pieces.forEach((ring, piece) => {
      const id = pieces.length === 1 ? allocationId : `${allocationId}-${piece + 1}`;
      model.spaces.push({ id, allocationId, typeId, usage, enclosed: false, boundary: convertBoundary(ring),
        targetArea: Math.abs(signedArea(ring)) * metersPerPixel ** 2, performancePreferences: { sourceLabelIds: labels.map((l) => l.id) } });
      spaceIdsByFace[index].push(id);
      for (const label of labels) mapping[label.id].push(id);
    });
  });
  for (let index = 0; index < faces.length; index++) for (const label of dimensionLabelsByFace[index]) mapping[label.id] = spaceIdsByFace[index];
  for (const divider of normalized.dividers) mapping[divider.id] = model.spaces.filter((s) => s.boundary.some((p) => distance(p, convert(divider.points[0])) < 1e-5)).map((s) => s.id);
  for (const u of input.uncertainties) issue(u.id, 'review', u.message, u.objectId ?? undefined, u.point ?? undefined);
  result.model = model;
  return result;
}
