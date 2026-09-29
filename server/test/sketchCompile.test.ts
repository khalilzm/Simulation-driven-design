import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSketch } from '../src/sketch/compile';
import { signedArea } from '../src/sketch/topology';
import { applyExtractionPatch, parseExtraction } from '../src/sketch/parse';
import { hashJson } from '../src/sketch/store';
import { validateStoredDesign } from '../src/model/designValidity';
import { modelToLineGroups } from '../../web/src/viewer/modelRender';
import { sketchFixture, sketchSource } from './helpers/sketch';
import type { SpaceModel, Vec2 } from '@sdd/shared';
import { SKETCH_HUMAN_REVIEW_ENABLED } from '@sdd/shared';

function assertUpwardBoundaries(model: SpaceModel): void {
  for (const ring of [model.floor.boundary, ...model.spaces.map((space) => space.boundary)]) {
    assert.deepEqual(ring[0], ring.at(-1), '边界保持闭合');
    assert.ok(signedArea(ring) > 0, '模型水平面须朝向 +Z，避免日照测点朝下');
  }
}

test('墙线推导两房，不补墙；文字原文、功能类型、门窗宿主与尺度保留', () => {
  const input = sketchFixture(), before = structuredClone(input);
  const compiled = compileSketch(parseExtraction(input, sketchSource), sketchSource, 'rev-0001');
  assert.deepEqual(input, before);
  assert.deepEqual(compiled.issues, []);
  assertUpwardBoundaries(compiled.model!);
  assert.deepEqual(compiled.model!.walls[0].geometry.points, [[1, 7], [9, 7]], '墙线保留原方向，门窗沿墙定位不变');
  assert.equal(compiled.model!.walls.length, 5);
  assert.equal(compiled.model!.spaces.length, 2);
  assert.equal(compiled.model!.spaces.reduce((n, s) => n + s.targetArea, 0), 48);
  assert.equal(compiled.model!.spaces.find((s) => s.id === 'space-L2')!.usage, '主卧');
  assert.equal(compiled.model!.spaceTypes!.find((s) => s.label === '卧室')!.label, '卧室');
  assert.equal(compiled.model!.openings[0].hostWallId, 'W5');
  assert.equal(compiled.model!.openings[0].position, 3);
  assert.equal(compiled.model!.doors[0].opensTo, 'left', 'Y 轴翻转后法向须反转');
  if (SKETCH_HUMAN_REVIEW_ENABLED) {
    assert.equal(validateStoredDesign(compiled.model).valid, false, '编译中间产物尚未标记 accepted，不能成为可分析方案');
    compiled.model!.model.sketchStatus = 'accepted';
  }
  assert.deepEqual(validateStoredDesign(compiled.model).errors, []);
});

test('反向重复墙合并后门窗仍位于同一物理位置，铰链与开启侧同步转换', () => {
  const input = sketchFixture();
  input.walls.push({ id: 'W6', points: [[500, 700], [500, 100]], thicknessPx: 20 });
  input.openings[0] = { ...input.openings[0], wallId: 'W6', position: 0.25 };
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.equal(result.model!.walls.length, 5);
  assert.deepEqual(result.mapping.W6, ['W5']);
  assert.equal(result.model!.openings[0].position, 4.5);
  assert.equal(result.model!.doors[0].hinge, 'end');
  assert.equal(result.model!.doors[0].opensTo, 'right');
});

test('吸附小断点有记录，大断点不自动补墙', () => {
  const input = sketchFixture(); input.walls[4].points[0][1] += 0.6;
  const snapped = compileSketch(input, sketchSource, 'rev-0001');
  assert.equal(snapped.model!.spaces.length, 2);
  assert.ok(snapped.adjustments.some((a) => a.objectId === 'W5' && a.distancePx < 1));
  input.walls[4].points[0][1] += 10;
  const gap = compileSketch(input, sketchSource, 'rev-0001');
  assert.equal(gap.model!.walls.length, 5);
  assert.ok(gap.issues.some((i) => i.id === 'unclosed-W5'));
  assert.equal(gap.model!.spaces.length, 1);
});

test('开放分界形成区域但不生成实体墙', () => {
  const input = sketchFixture(); input.walls.pop(); input.openings.shift();
  input.dividers.push({ id: 'V1', points: [[500, 100], [500, 700]], evidence: '原图虚线分界' });
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.equal(result.model!.walls.length, 4);
  assert.equal(result.model!.spaces.length, 2);
});

test('失效宿主、越界洞口、冲突尺度均保留诊断，不能伪装完整', () => {
  const input = sketchFixture(); input.openings[0].wallId = 'missing'; input.openings[1].position = 0;
  input.dimensions.push({ id: 'M2', points: [[100, 100], [900, 100]], lengthM: 20, text: '20m' });
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.ok(result.issues.filter((i) => i.severity === 'error').length >= 3);
  assert.deepEqual(result.mapping.D1, []);
  assert.deepEqual(result.mapping.N1, []);
});

test('缺少尺度和文字保留为待确认信息', () => {
  const input = sketchFixture(); input.dimensions = []; input.labels = []; input.heightM = null;
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.equal(result.calibrated, false);
  assert.ok(result.issues.some((i) => i.id === 'scale-missing'));
  assert.equal(result.issues.filter((i) => i.id.startsWith('unlabelled-')).length, 2);
});

test('定点补丁只修改指定对象，拒绝旧版本与跨图补丁', () => {
  const input = sketchFixture(), hash = hashJson(input);
  const next = applyExtractionPatch(input, { sketchId: input.sketchId, baseHash: hash,
    labels: { upsert: [{ ...input.labels[1], text: '书房', usage: '书房' }] } }, sketchSource, hash);
  assert.deepEqual(next.walls, input.walls);
  assert.deepEqual(next.openings, input.openings);
  assert.equal(next.labels[1].text, '书房');
  assert.equal(input.labels[1].text, '主卧');
  assert.throws(() => applyExtractionPatch(input, { sketchId: 'old', baseHash: hash }, sketchSource, hash));
  assert.throws(() => applyExtractionPatch(input, { sketchId: input.sketchId, baseHash: 'old' }, sketchSource, hash));
});

test('门的铰链和开启侧影响实际平面渲染', () => {
  const result = compileSketch(sketchFixture(), sketchSource, 'rev-0001');
  const before = modelToLineGroups(result.model!);
  result.model!.doors[0].opensTo = 'right';
  assert.notDeepEqual(modelToLineGroups(result.model!), before);
  const reversed = modelToLineGroups(result.model!);
  result.model!.doors[0].hinge = 'end';
  assert.notDeepEqual(modelToLineGroups(result.model!), reversed);
});

test('凹外轮廓由墙线保持 L 形，面积不会被矩形包围盒填满', () => {
  const input = sketchFixture();
  const ring: Vec2[] = [[100, 100], [900, 100], [900, 400], [500, 400], [500, 700], [100, 700], [100, 100]];
  input.walls = ring.slice(1).map((p, i) => ({ id: `W${i + 1}`, points: [ring[i], p], thicknessPx: 20 }));
  input.walls.push({ id: 'W7', points: [[100, 400], [500, 400]], thicknessPx: 20 });
  input.openings = [];
  input.labels[0].point = [300, 250]; input.labels[1].point = [300, 550];
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.deepEqual(result.issues, []);
  assert.equal(result.model!.walls.length, 7);
  assert.equal(result.model!.spaces.length, 2);
  assert.equal(result.model!.spaces.reduce((sum, s) => sum + s.targetArea, 0), 36);
  assertUpwardBoundaries(result.model!);
});

test('独立内环推导环绕区域时排除内室，空间不重叠', () => {
  const input = sketchFixture(); input.walls.pop(); input.openings = [];
  const room: Vec2[] = [[400, 300], [600, 300], [600, 500], [400, 500], [400, 300]];
  input.walls.push(...room.slice(1).map((p, i) => ({ id: `I${i}`, points: [room[i], p], thicknessPx: 20 })));
  input.labels[1].point = [500, 400];
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.deepEqual(result.issues, []);
  assert.equal(result.model!.spaces.reduce((sum, s) => sum + s.targetArea, 0), 48);
  assert.ok(result.mapping.L1.length > 1, '带孔区域分解成同一 allocation 下的简单多边形');
  assertUpwardBoundaries(result.model!);
});

test('穿过墙体接点的窗洞不能生成，保留定位问题', () => {
  const input = sketchFixture(); input.openings[1].position = 0.5;
  const result = compileSketch(input, sketchSource, 'rev-0001');
  assert.deepEqual(result.mapping.N1, []);
  assert.ok(result.issues.some((i) => i.id === 'junction-N1' && i.severity === 'error'));
});

test('米制墙厚标注由程序直接采用，模型无需反算像素厚度', () => {
  const input = sketchFixture();
  input.walls = input.walls.map((w) => ({ ...w, thicknessPx: null, thicknessM: 0.2 }));
  const result = compileSketch(parseExtraction(input, sketchSource), sketchSource, 'rev-0001');
  assert.deepEqual(result.issues, []);
  assert.ok(result.model!.walls.every((w) => w.thickness === 0.2));
});
