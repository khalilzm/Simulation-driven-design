import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SketchReport, Vec2 } from '@sdd/shared';
import { along, length } from './topology';

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

export async function renderSketchOverlay(cwd: string, report: SketchReport): Promise<string> {
  const { source, extraction, model, metersPerPixel: scale } = report;
  const lines: string[] = [];
  const font = Math.max(12, Math.max(source.width, source.height) / 70);
  const label = (p: Vec2, text: string, color: string) => lines.push(`<text x="${p[0] + 3}" y="${p[1] - 4}" fill="${color}" font-size="${font}" font-family="sans-serif" paint-order="stroke" stroke="white" stroke-width="2">${escape(text)}</text>`);
  const polyline = (points: Vec2[], color: string, width: number, dash = '') => lines.push(`<polyline points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`);
  const pixel = ([x, y]: Vec2): Vec2 => [x / scale, source.height - y / scale];
  if (model) {
    for (const wall of model.walls) {
      const pts = wall.geometry.points.map(pixel);
      polyline(pts, '#1565c0', 3);
      label(along(pts, length(pts) * 0.35), wall.id, '#1565c0');
    }
    for (const opening of model.openings) {
      const wall = model.walls.find((w) => w.id === opening.hostWallId)!;
      const pts = wall.geometry.points;
      const a = along(pts, opening.position - opening.width / 2), b = along(pts, opening.position + opening.width / 2);
      const door = model.doors.find((d) => d.openingId === opening.id);
      const isWindow = model.windows.some((w) => w.openingId === opening.id);
      const color = isWindow ? '#009688' : '#d46b08';
      polyline([pixel(a), pixel(b)], 'white', 8);
      polyline([pixel(a), pixel(b)], color, 4);
      label(pixel(along(pts, opening.position)), `${opening.id} ${isWindow ? '窗' : door ? '门' : '通道'}`, color);
      if (door && door.swing !== 'none') {
        const n = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const ux = (b[0] - a[0]) / n, uy = (b[1] - a[1]) / n, sign = door.opensTo === 'right' ? -1 : 1;
        const hinges = door.leafCount === 2 ? [a, b] : [door.hinge === 'end' ? b : a];
        for (const hinge of hinges) {
          const radius = opening.width / (door.leafCount === 2 ? 2 : 1);
          const direction = hinge === b ? -1 : 1;
          const tip: Vec2 = [hinge[0] - uy * radius * sign, hinge[1] + ux * radius * sign];
          polyline([pixel(hinge), pixel(tip)], color, 2);
          const arc = Array.from({ length: 13 }, (_, i): Vec2 => {
            const t = i * Math.PI / 24;
            return pixel([hinge[0] + radius * (ux * direction * Math.cos(t) - uy * sign * Math.sin(t)), hinge[1] + radius * (uy * direction * Math.cos(t) + ux * sign * Math.sin(t))]);
          });
          polyline(arc, color, 1);
        }
      }
    }
  } else if (extraction) {
    for (const wall of extraction.walls) { polyline(wall.points, '#c62828', 2, '6 3'); label(wall.points[0], wall.id, '#c62828'); }
  }
  for (const divider of extraction?.dividers ?? []) polyline(divider.points, '#7b1fa2', 2, '6 3');
  for (const item of extraction?.labels ?? []) {
    const color = item.kind === 'dimension' ? '#00695c' : '#7b1fa2';
    label(item.point, `${item.id}: ${item.text}`, color);
    lines.push(`<circle cx="${item.point[0]}" cy="${item.point[1]}" r="3" fill="${color}"/>`);
  }
  for (const issue of report.issues) if (issue.point && issue.severity !== 'info') {
    lines.push(`<circle cx="${issue.point[0]}" cy="${issue.point[1]}" r="${font}" fill="none" stroke="#d32f2f" stroke-width="2"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}" viewBox="0 0 ${source.width} ${source.height}">${lines.join('')}</svg>`;
  const folder = path.join(cwd, 'designs', report.revisionId);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'sketch-overlay.svg'), svg);
  const overlayPath = `designs/${report.revisionId}/sketch-overlay.png`;
  const buffer = await sharp(path.join(cwd, source.imagePath)).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  fs.writeFileSync(path.join(cwd, overlayPath), buffer);
  return overlayPath;
}
