import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import DxfParser, { type ILwpolylineEntity } from 'dxf-parser';
import { wallSolidPrisms, type DxfUploadResponse } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { validateStoredDesign } from '../src/model/designValidity';
import { handleUpload } from '../src/routes/uploads';
import { isAcceptedDesign, listDesigns, loadDesign } from '../src/model/store';
import { workspacesDir } from '../src/config';
import { modelToLineGroups, modelToWallFills, modelToWallBoxes3D, modelToWindowFills, modelToWindowMeshes3D } from '../../web/src/viewer/modelRender';
import { FIXED_ENVELOPE_COLORS } from '../../web/src/viewer/fixedEnvelopePresentation';

const fixture = fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf', import.meta.url), 'utf8');
const near = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

/** Serialize just the fixture's polylines to vary units/vertex coordinates independently of the importer. */
function variant(options: { unit?: number; offset?: number; angle?: number; reverse?: boolean; mutate?: (entities: ILwpolylineEntity[]) => void } = {}) {
  const entities = new DxfParser().parseSync(fixture)!.entities.filter((e) => e.type === 'LWPOLYLINE') as ILwpolylineEntity[];
  options.mutate?.(entities);
  const unit = options.unit ?? 4;
  const factor = unit === 6 ? 0.001 : 1;
  const angle = options.angle ?? 0, offset = options.offset ?? 0;
  const pairs: (string | number)[] = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, unit, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES'];
  for (const e of entities) {
    pairs.push(0, 'LWPOLYLINE', 8, e.layer, 90, e.vertices.length, 70, e.shape ? 1 : 0);
    const vertices = options.reverse ? [...e.vertices].reverse() : e.vertices;
    for (const p of vertices) pairs.push(10, (p.x * Math.cos(angle) - p.y * Math.sin(angle) + offset) * factor,
      20, (p.x * Math.sin(angle) + p.y * Math.cos(angle) + offset) * factor, 42, p.bulge ?? 0);
    if (e.extendedData) pairs.push(1001, 'SDD_FIXED', 1000, e.extendedData.customStrings[0]);
  }
  pairs.push(0, 'ENDSEC', 0, 'EOF');
  return pairs.join('\n') + '\n';
}

test('住宅 DXF 解析实际交付文件：轮廓、墙体、入户与窗洞均为米制模型', () => {
  const m = parseFixedEnvelopeDxf(fixture, 'residential.dxf');
  assert.equal(m.model.units, 'm');
  assert.deepEqual(m.model.dxfSource?.counts, { outlines: 1, loadBearingWalls: 12, entrances: 1, windows: 5 });
  assert.deepEqual(m.model.dxfSource?.warnings, []);
  assert.deepEqual(m.floor.boundary, [[0,0],[12,0],[12,9],[0,9],[0,0]]);
  near(m.floor.height, 2.8);
  assert.equal(m.spaces.length, 0, '不编造房间或将轮廓伪装成房间');
  assert.ok(validateStoredDesign(m).valid);
  assert.ok(m.walls.every((w) => w.fixed && w.role === 'structural'));
  const d = m.doors[0], o = m.openings.find((p) => p.id === d.openingId)!;
  const host = m.walls.find((w) => w.id === o.hostWallId)!;
  near(o.width, 1); near(o.height, 2.1);
  near(host.geometry.points[0][0], 5.5); near(host.geometry.points[0][1], 8.9);
  assert.equal(d.hinge, 'start'); assert.equal(d.opensTo, 'right');
  for (const w of m.windows) {
    const opening = m.openings.find((p) => p.id === w.openingId)!;
    near(opening.height, 1.2); near(opening.sillHeight!, 0.9);
    near(opening.width, w.id === 'W2' ? 2 : 1.8);
  }
});

test('毫米/米、整体平移、旋转与反向顶点均保留实际尺寸', () => {
  const mm = parseFixedEnvelopeDxf(variant({ offset: 100000 }), 'mm.dxf');
  const m = parseFixedEnvelopeDxf(variant({ unit: 6, offset: 100000, reverse: true }), 'm.dxf');
  near(mm.model.dxfSource!.areaM2, 108); near(m.model.dxfSource!.areaM2, 108);
  assert.deepEqual(m.model.origin, [100,100]);
  for (const wall of mm.walls) {
    const other = m.walls.find((w) => w.id === wall.id)!;
    near(wall.thickness, other.thickness);
    wall.geometry.points.forEach((p, i) => p.forEach((v, j) => near(v, other.geometry.points[i][j])));
  }
  const rotated = parseFixedEnvelopeDxf(variant({ angle: Math.PI / 6, reverse: true }), 'rotated.dxf');
  near(rotated.model.dxfSource!.areaM2, 108);
  rotated.walls.forEach((w) => near(w.thickness, 0.2));
  near(rotated.openings.find((o) => o.fillRef === 'W2')!.width, 2);
});

test('二维填充不堵门窗洞；三维保留窗台与过梁且玻璃高程正确', () => {
  const model = parseFixedEnvelopeDxf(fixture, 'test.dxf');
  const fills = modelToWallFills(model);
  assert.equal(fills.length, 12);
  let area = 0;
  for (const { mesh } of fills) for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a,b,c] = [...mesh.indices.slice(i,i+3)].map((j) => [...mesh.positions.slice(j*3,j*3+3)]);
    area += Math.abs((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/2;
  }
  near(area, 7.48, 1e-5);
  assert.equal(modelToWindowFills(model).length, 5);
  for (const o of model.openings) {
    const host = model.walls.find((w) => w.id === o.hostWallId)!;
    const prisms = wallSolidPrisms(host, model.openings);
    const ranges = prisms.map((p) => [p.z0,p.z1]);
    assert.deepEqual(ranges, o.fillRef === 'D1' ? [[2.1,2.8]] : [[0,0.9],[2.1,2.8]]);
  }
  assert.equal(modelToWallBoxes3D(model).length, 23);
  const glass = modelToWindowMeshes3D(model).filter((f) => f.meshId?.includes('glass'));
  assert.equal(glass.length, 5);
  for (const { mesh } of glass) {
    const z = [...mesh.positions].filter((_,i) => i%3===2);
    near(Math.min(...z), 0.9); near(Math.max(...z), 2.1);
  }
  const doorLines = modelToLineGroups(model).find((g) => g.color === FIXED_ENVELOPE_COLORS.entrance)!;
  const ys = doorLines.positions.filter((_, i) => i % 3 === 1);
  near(Math.min(...ys), 7.9); near(Math.max(...ys), 8.9);
});

test('拒绝未知单位、非闭合/圆弧构件、重复轮廓、越界及无法宿主的洞口', () => {
  assert.throws(() => parseFixedEnvelopeDxf(variant({ unit: 0 }), 'bad.dxf'), /单位/);
  assert.throws(() => parseFixedEnvelopeDxf(variant({ mutate: (e) => { e[0].shape = false; } }), 'bad.dxf'), /未闭合/);
  assert.throws(() => parseFixedEnvelopeDxf(variant({ mutate: (e) => { e[1].vertices[0].bulge = 1; } }), 'bad.dxf'), /圆弧/);
  assert.throws(() => parseFixedEnvelopeDxf(variant({ mutate: (e) => { e.push(e[0]); } }), 'bad.dxf'), /仅允许 1/);
  assert.throws(() => parseFixedEnvelopeDxf(variant({ mutate: (e) => { e[1].vertices.forEach((p) => p.x -= 20000); } }), 'bad.dxf'), /超出/);
  assert.throws(() => parseFixedEnvelopeDxf(variant({ mutate: (e) => {
    e.find((p) => p.layer === 'FIXED_ENTRANCE')!.vertices.forEach((p) => p.y -= 2000);
  } }), 'bad.dxf'), /宿主/);
});

async function upload(t: TestContext, filename: string, data: string, sessionId = `test-dxf-${randomUUID()}`) {
  t.after(() => fs.rmSync(path.join(workspacesDir, sessionId), { recursive: true, force: true }));
  let status = 200, body: DxfUploadResponse & { error?: string };
  const res = { status(code: number) { status=code; return this; }, json(value: typeof body) { body=value; return this; } } as Response;
  await handleUpload({ body: { sessionId, filename, contentBase64: Buffer.from(data).toString('base64') } } as Request, res);
  return { status, body: body!, sessionId };
}

test('上传立即持久化有效版本、保留原图；重复上传不覆盖；错误图纸不产生方案', async (t) => {
  const first = await upload(t, '住宅.DXF', fixture);
  assert.equal(first.status, 200, first.body.error);
  assert.ok(isAcceptedDesign(first.sessionId, first.body.revisionId));
  assert.deepEqual(loadDesign(first.sessionId, first.body.revisionId), first.body.model);
  assert.equal(fs.readFileSync(path.join(workspacesDir, first.sessionId, 'inputs', first.body.file.name), 'utf8'), fixture);
  const second = await upload(t, '住宅.DXF', fixture, first.sessionId);
  assert.notEqual(first.body.revisionId, second.body.revisionId);
  assert.notEqual(first.body.file.name, second.body.file.name);
  assert.equal(listDesigns(first.sessionId).filter((d) => d.valid).length, 2);
  const bad = await upload(t, 'bad.dxf', variant({ unit: 0 }), first.sessionId);
  assert.equal(bad.status, 400); assert.equal(listDesigns(first.sessionId).length, 2);
});
