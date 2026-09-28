import type { Vec2 } from '@sdd/shared';
import { closePolygon } from '../model/geometry';
import type { LayoutBoundarySpec, LayoutSpaceSpec } from './layoutPlanTypes';
import { segmentCoveredBy } from './layoutWalls';
import { sharedSegments } from './regionGeometry';

function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(v: Vec2, s: number): Vec2 {
  return [v[0] * s, v[1] * s];
}

function len(v: Vec2): number {
  return Math.hypot(v[0], v[1]);
}

function clamp(t: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, t));
}

/** 将外轮廓窗/门 boundary 的 segment 投影到 space 与 floor 的真实共边上。 */
export function snapExteriorBoundarySegments(
  boundaries: LayoutBoundarySpec[],
  spaces: LayoutSpaceSpec[],
  floorBoundary: Vec2[],
): { boundaries: LayoutBoundarySpec[]; notes: string[] } {
  const notes: string[] = [];
  const floorRing = closePolygon(floorBoundary, 0);
  const out = boundaries.map((boundary) => {
    if (boundary.leftSpaceId !== 'outside' && boundary.rightSpaceId !== 'outside') return boundary;
    const spaceId = boundary.leftSpaceId === 'outside' ? boundary.rightSpaceId : boundary.leftSpaceId;
    const space = spaces.find((s) => s.id === spaceId);
    if (!space) return boundary;
    const shared = sharedSegments(space.boundary, floorRing);
    if (!shared.length) return boundary;
    if (segmentCoveredBy(boundary.segment[0], boundary.segment[1], shared)) return boundary;
    const seg = boundary.segment;
    const segMid: Vec2 = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2];
    const segDir = sub(seg[1], seg[0]);
    const segLen = len(segDir) || 1;
    let best: { edge: [Vec2, Vec2]; score: number } | null = null;
    for (const edge of shared) {
      const eDir = sub(edge[1], edge[0]);
      const el = len(eDir) || 1;
      const align = Math.abs(dot([segDir[0] / segLen, segDir[1] / segLen], [eDir[0] / el, eDir[1] / el]));
      const mid: Vec2 = [(edge[0][0] + edge[1][0]) / 2, (edge[0][1] + edge[1][1]) / 2];
      const dist = len(sub(segMid, mid));
      const score = align * 2 - dist * 0.05;
      if (!best || score > best.score) best = { edge, score };
    }
    if (!best || best.score < 0.3) return boundary;
    const [a, b] = best.edge;
    const ab = sub(b, a);
    const abLen2 = dot(ab, ab);
    if (abLen2 < 1e-12) return boundary;
    let t = dot(sub(segMid, a), ab) / abLen2;
    const half = Math.min(segLen / 2, Math.sqrt(abLen2) / 2 - 1e-4);
    if (half <= 1e-4) return boundary;
    t = clamp(t, half / Math.sqrt(abLen2), 1 - half / Math.sqrt(abLen2));
    const center = add(a, scale(ab, t));
    const u = scale(ab, 1 / Math.sqrt(abLen2));
    const snapped: [Vec2, Vec2] = [sub(center, scale(u, half)), add(center, scale(u, half))];
    const moved = len(sub(snapped[0], seg[0])) + len(sub(snapped[1], seg[1])) > 1e-3;
    if (moved) notes.push(`已 snap 外边界 ${boundary.id} 至 ${spaceId}/outside 共边`);
    return { ...boundary, segment: snapped };
  });
  return { boundaries: out, notes };
}
