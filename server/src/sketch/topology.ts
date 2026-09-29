import type { SketchCompilation, SketchExtraction, SketchIssue, Vec2 } from '@sdd/shared';

const EPS = 1e-6;
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
export function signedArea(ring: Vec2[]): number {
  return ring.slice(1).reduce((sum, p, i) => sum + ring[i][0] * p[1] - p[0] * ring[i][1], 0) / 2;
}
export function length(points: Vec2[]): number {
  return points.slice(1).reduce((sum, p, i) => sum + distance(points[i], p), 0);
}
export function along(points: Vec2[], at: number): Vec2 {
  let remaining = at;
  for (let i = 0; i + 1 < points.length; i++) {
    const n = distance(points[i], points[i + 1]);
    if (remaining <= n || i === points.length - 2) {
      const t = n ? remaining / n : 0;
      return [points[i][0] + t * (points[i + 1][0] - points[i][0]), points[i][1] + t * (points[i + 1][1] - points[i][1])];
    }
    remaining -= n;
  }
  return points[0];
}
function projection(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1);
  return { point: [a[0] + t * dx, a[1] + t * dy], t };
}
interface Segment { a: Vec2; b: Vec2; id: string; cuts: number[] }

/** Node a planar line graph. Physical wall IDs and direction are never split/reversed. */
export function buildSketchTopology(extraction: SketchExtraction, tolerance: number): {
  normalized: SketchExtraction;
  faces: Vec2[][];
  issues: SketchIssue[];
  adjustments: SketchCompilation['adjustments'];
  aliases: Map<string, { id: string; reversed: boolean }>;
} {
  const normalized = structuredClone(extraction);
  const issues: SketchIssue[] = [], adjustments: SketchCompilation['adjustments'] = [];
  const lines = [...normalized.walls, ...normalized.dividers];
  const anchors: Vec2[] = [];
  for (const line of lines) {
    for (let i = 0; i < line.points.length; i++) {
      const from = line.points[i];
      const anchor = anchors.find((p) => distance(p, from) <= tolerance);
      if (anchor) {
        if (distance(from, anchor) > EPS) adjustments.push({ objectId: line.id, from, to: anchor, distancePx: distance(from, anchor) });
        line.points[i] = [...anchor];
      } else anchors.push(from);
    }
  }
  // Snap near T-junction endpoints onto the closest observed segment, bounded by tolerance.
  const moved = new Map<string, Vec2>();
  for (const line of lines) for (const index of [0, line.points.length - 1]) {
    const from = line.points[index];
    let best: Vec2 | undefined, bestDistance = tolerance + EPS;
    for (const other of lines) {
      if (other === line) continue;
      for (let j = 0; j + 1 < other.points.length; j++) {
        const p = projection(from, other.points[j], other.points[j + 1]);
        const d = distance(from, p.point);
        if (p.t > EPS && p.t < 1 - EPS && d > EPS && d < bestDistance) { best = p.point; bestDistance = d; }
      }
    }
    if (best && !moved.has(from.join(','))) moved.set(from.join(','), best);
  }
  for (const line of lines) line.points = line.points.map((from) => {
    const to = moved.get(from.join(','));
    if (!to) return from;
    adjustments.push({ objectId: line.id, from, to, distancePx: distance(from, to) });
    return [...to];
  }) as typeof line.points;

  const aliases = new Map<string, { id: string; reversed: boolean }>();
  const canonical = new Map<string, string>();
  normalized.walls = normalized.walls.filter((wall) => {
    const key = JSON.stringify(wall.points), reverse = JSON.stringify([...wall.points].reverse());
    const match = canonical.get(key) ?? canonical.get(reverse);
    if (match) {
      const previous = normalized.walls.find((w) => w.id === match)!;
      if (wall.thicknessPx !== previous.thicknessPx || wall.thicknessM !== previous.thicknessM) issues.push({ id: `duplicate-thickness-${wall.id}`, objectId: wall.id,
        severity: 'review', message: `重复墙线与 ${match} 的厚度不一致，请确认采用的墙厚` });
      aliases.set(wall.id, { id: match, reversed: !canonical.has(key) });
      issues.push({ id: `duplicate-${wall.id}`, objectId: wall.id, severity: 'info', message: `重复墙线并入 ${match}` });
      return false;
    }
    canonical.set(key, wall.id); aliases.set(wall.id, { id: wall.id, reversed: false }); return true;
  });
  const segments: Segment[] = [];
  for (const line of [...normalized.walls, ...normalized.dividers]) for (let i = 0; i + 1 < line.points.length; i++) {
    if (distance(line.points[i], line.points[i + 1]) < EPS) {
      issues.push({ id: `collapsed-${line.id}-${i}`, objectId: line.id, severity: 'error', message: '容差吸附后线段坍缩，请核对端点' });
      continue;
    }
    segments.push({ a: line.points[i], b: line.points[i + 1], id: line.id, cuts: [0, 1] });
  }
  const cross = (x: number, y: number, u: number, v: number) => x * v - y * u;
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const s = segments[i], q = segments[j];
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], ex = q.b[0] - q.a[0], ey = q.b[1] - q.a[1];
    const denominator = cross(dx, dy, ex, ey);
    if (Math.abs(denominator) > EPS) {
      const t = cross(q.a[0] - s.a[0], q.a[1] - s.a[1], ex, ey) / denominator;
      const u = cross(q.a[0] - s.a[0], q.a[1] - s.a[1], dx, dy) / denominator;
      if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS) {
        s.cuts.push(Math.max(0, Math.min(1, t))); q.cuts.push(Math.max(0, Math.min(1, u)));
      }
    } else if (Math.abs(cross(q.a[0] - s.a[0], q.a[1] - s.a[1], dx, dy)) < EPS) {
      const p0 = projection(q.a, s.a, s.b).t, p1 = projection(q.b, s.a, s.b).t;
      const lo = Math.max(0, Math.min(p0, p1)), hi = Math.min(1, Math.max(p0, p1));
      if (hi - lo > EPS && s.id !== q.id) issues.push({ id: `overlap-${i}-${j}`, objectId: s.id, severity: 'error', message: `${s.id} 与 ${q.id} 部分重叠，请合并识别墙线并更新门窗引用` });
      for (const p of [q.a, q.b]) { const t = projection(p, s.a, s.b).t; if (t >= 0 && t <= 1) s.cuts.push(t); }
      for (const p of [s.a, s.b]) { const t = projection(p, q.a, q.b).t; if (t >= 0 && t <= 1) q.cuts.push(t); }
    }
  }
  const vertices: Vec2[] = [], vertexMap = new Map<string, number>();
  const vertex = (p: Vec2) => {
    const key = p.map((v) => v.toFixed(5)).join(',');
    const found = vertexMap.get(key);
    if (found !== undefined) return found;
    if (vertices.length >= 4096) throw new Error('墙线交点超过 4096 个，请核对识别结果或拆分草图');
    const id = vertices.length; vertices.push(p); vertexMap.set(key, id); return id;
  };
  const edges: { a: number; b: number; id: string }[] = [], edgeSet = new Set<string>();
  for (const s of segments) {
    const ts = [...new Set(s.cuts)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < ts.length; i++) {
      const at = (t: number): Vec2 => [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
      const a = vertex(at(ts[i])), b = vertex(at(ts[i + 1]));
      if (a === b) continue;
      const key = [a, b].sort((x, y) => x - y).join(',');
      if (!edgeSet.has(key)) { edges.push({ a, b, id: s.id }); edgeSet.add(key); }
    }
  }
  // Bridges do not enclose a face. Keep them as physical walls and flag uncertain partitions.
  const adjacency = vertices.map(() => [] as { vertex: number; edge: number }[]);
  edges.forEach((e, i) => { adjacency[e.a].push({ vertex: e.b, edge: i }); adjacency[e.b].push({ vertex: e.a, edge: i }); });
  const seen = new Array(vertices.length).fill(-1), low = [...seen], bridges = new Set<number>();
  let clock = 0;
  const visit = (v: number, parent: number) => {
    seen[v] = low[v] = clock++;
    for (const n of adjacency[v]) {
      if (n.edge === parent) continue;
      if (seen[n.vertex] < 0) {
        visit(n.vertex, n.edge); low[v] = Math.min(low[v], low[n.vertex]);
        if (low[n.vertex] > seen[v]) bridges.add(n.edge);
      } else low[v] = Math.min(low[v], seen[n.vertex]);
    }
  };
  vertices.forEach((_, i) => { if (seen[i] < 0) visit(i, -1); });
  for (const id of new Set([...bridges].map((i) => edges[i].id))) issues.push({ id: `unclosed-${id}`, objectId: id, severity: 'review', message: '此线段未参与闭合区域；请确认是独立墙体还是识别断点' });
  const neighbors = adjacency.map((items, i) => items.filter((n) => !bridges.has(n.edge)).map((n) => n.vertex)
    .sort((a, b) => Math.atan2(vertices[a][1] - vertices[i][1], vertices[a][0] - vertices[i][0]) - Math.atan2(vertices[b][1] - vertices[i][1], vertices[b][0] - vertices[i][0])));
  const visited = new Set<string>(), faces: Vec2[][] = [];
  for (const edge of edges) for (const [from, to] of [[edge.a, edge.b], [edge.b, edge.a]]) {
    if (!neighbors[from].includes(to) || visited.has(`${from}:${to}`)) continue;
    const ring: Vec2[] = [];
    let a = from, b = to;
    for (let n = 0; n <= edges.length * 2; n++) {
      const key = `${a}:${b}`;
      if (visited.has(key)) break;
      visited.add(key); ring.push(vertices[a]);
      const list = neighbors[b], incoming = list.indexOf(a);
      const next = list[(incoming + list.length - 1) % list.length];
      a = b; b = next;
      if (a === from && b === to) { ring.push(vertices[from]); if (signedArea(ring) > EPS) faces.push(ring); break; }
    }
  }
  if (!faces.length) issues.push({ id: 'no-enclosure', severity: 'error', message: '墙线没有形成闭合区域，请修正断点；程序不会自动补墙' });
  return { normalized, faces, issues, adjustments, aliases };
}
