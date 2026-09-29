import type { SketchExtraction, SketchSource, Vec2 } from '@sdd/shared';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}
function array(value: unknown, field: string, limit = 512): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${field} 必须是数组，最多 ${limit} 项`);
  return value;
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error(`${field} 必须是非空文本`);
  return value.trim();
}
function number(value: unknown, field: string, min = 0, max = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${field} 必须是 ${min}～${max} 的有限数值`);
  return value;
}
function optionalNumber(value: unknown, field: string, min = 0): number | null {
  return value == null ? null : number(value, field, min);
}
function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (!values.includes(value as T)) throw new Error(`${field} 必须是 ${values.join('/')}`);
  return value as T;
}

export function parseExtraction(raw: unknown, source: SketchSource): SketchExtraction {
  const root = object(raw, 'sketch');
  if (root.schemaVersion !== 1 || root.sketchId !== source.id || root.coordinateSystem !== 'image-pixels') {
    throw new Error('schemaVersion 必须为 1，sketchId 必须匹配当前图片，coordinateSystem 必须为 image-pixels');
  }
  const used = new Set<string>();
  const id = (value: unknown): string => {
    const s = string(value, 'id');
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(s) || used.has(s)) throw new Error(`对象 id 非法或重复：${s}`);
    used.add(s); return s;
  };
  const point = (value: unknown): Vec2 => {
    if (!Array.isArray(value) || value.length !== 2) throw new Error('坐标必须为 [x,y]');
    return [number(value[0], 'x', 0, source.width), number(value[1], 'y', 0, source.height)];
  };
  const points = (value: unknown, count?: number): Vec2[] => {
    const list = array(value, 'points', 64).map(point);
    if (list.length < 2 || (count && list.length !== count)) throw new Error('线段需要两个端点，折线至少两个点');
    if (list.slice(1).some((p, i) => Math.hypot(p[0] - list[i][0], p[1] - list[i][1]) < 1e-5)) throw new Error('线段长度不能为零');
    return list;
  };
  const walls = array(root.walls, 'walls', 256).map((raw) => {
    const w = object(raw, 'wall');
    return { id: id(w.id), points: points(w.points), thicknessPx: optionalNumber(w.thicknessPx, 'thicknessPx', 0.01),
      ...(w.thicknessM !== undefined ? { thicknessM: optionalNumber(w.thicknessM, 'thicknessM', 0.01) } : {}) };
  });
  if (!walls.length) throw new Error('至少需要一条识别墙线');
  const openings = array(root.openings, 'openings').map((raw) => {
    const o = object(raw, 'opening');
    const leafCount = o.leafCount == null ? null : number(o.leafCount, 'leafCount', 1, 2);
    if (leafCount !== null && leafCount !== 1 && leafCount !== 2) throw new Error('leafCount 必须为 1/2/null');
    return {
      id: id(o.id), kind: choice(o.kind, ['door', 'window', 'passage', 'unknown'], 'kind'),
      wallId: string(o.wallId, 'wallId'), position: number(o.position, 'position', 0, 1),
      widthPx: number(o.widthPx, 'widthPx', 0.01),
      heightM: optionalNumber(o.heightM, 'heightM', 0.01), sillHeightM: optionalNumber(o.sillHeightM, 'sillHeightM'),
      hinge: o.hinge == null ? null : choice(o.hinge, ['start', 'end'], 'hinge'),
      opensTo: o.opensTo == null ? null : choice(o.opensTo, ['left', 'right'], 'opensTo'),
      leafCount: leafCount as 1 | 2 | null,
    };
  });
  const labels = array(root.labels, 'labels').map((raw) => {
    const l = object(raw, 'label');
    return { id: id(l.id), text: string(l.text, 'text'), usage: l.usage == null ? null : string(l.usage, 'usage'), point: point(l.point) };
  });
  const dividers = array(root.dividers ?? [], 'dividers').map((raw) => {
    const d = object(raw, 'divider');
    return { id: id(d.id), points: points(d.points, 2) as [Vec2, Vec2], evidence: string(d.evidence, 'evidence') };
  });
  const dimensions = array(root.dimensions ?? [], 'dimensions').map((raw) => {
    const d = object(raw, 'dimension');
    return { id: id(d.id), points: points(d.points, 2) as [Vec2, Vec2], lengthM: number(d.lengthM, 'lengthM', 0.001), text: string(d.text, 'text') };
  });
  if (walls.reduce((n, w) => n + w.points.length - 1, dividers.length) > 512) throw new Error('草图线段超过 512 条，请按楼层拆分输入');
  const uncertainties = array(root.uncertainties ?? [], 'uncertainties').map((raw) => {
    const u = object(raw, 'uncertainty');
    return { id: id(u.id), objectId: u.objectId == null ? null : string(u.objectId, 'objectId'), message: string(u.message, 'message'), point: u.point == null ? null : point(u.point) };
  });
  return { schemaVersion: 1, sketchId: source.id, coordinateSystem: 'image-pixels', walls, openings, labels, dividers, dimensions,
    heightM: optionalNumber(root.heightM, 'heightM', 0.01), uncertainties };
}

/** Patch individual source objects; everything omitted is preserved exactly. */
export function applyExtractionPatch(base: SketchExtraction, raw: unknown, source: SketchSource, hash: string): SketchExtraction {
  const patch = object(raw, 'patch');
  if (patch.sketchId !== source.id || patch.baseHash !== hash) throw new Error('修正基于过期的识别结果');
  const next = structuredClone(base);
  for (const name of ['walls', 'openings', 'labels', 'dividers', 'dimensions', 'uncertainties'] as const) {
    if (patch[name] === undefined) continue;
    const ops = object(patch[name], name);
    const remove = array(ops.remove ?? [], `${name}.remove`).map((v) => string(v, 'remove id'));
    const upsert = array(ops.upsert ?? [], `${name}.upsert`).map((v) => object(v, 'upsert'));
    const existing = new Map<string, unknown>(next[name].map((item) => [item.id, item]));
    for (const id of remove) {
      if (!existing.delete(id)) throw new Error(`不能删除不存在的 ${id}`);
    }
    for (const item of upsert) existing.set(string(item.id, 'id'), item);
    (next as unknown as Record<string, unknown>)[name] = [...existing.values()];
  }
  if ('heightM' in patch) next.heightM = patch.heightM as number | null;
  return parseExtraction(next, source);
}
