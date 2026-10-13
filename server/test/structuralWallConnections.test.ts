import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createResidentialBrief, layoutSettings, parseResidentialBrief, resolveWallJunctions, wallEndTrims, wallStripPolygon, type SpaceModel, type Vec2, type Wall } from '@sdd/shared';
import { connectPartitionsToStructure, assessStructuralConnections } from '../src/design/structuralWallConnections';
import { geometryArea, intersection } from '../src/geometry/regions';
import { layoutModel } from './helpers/spaceModel';

const wall=(id:string,points:Vec2[],thickness:number,fixed=false):Wall=>({id,geometry:{type:'polyline',points},thickness,height:2.8,fixed,role:fixed?'structural':'partition',...(!fixed?{generatedBy:'layout-grid-v1' as const}:{})});
const host=()=>wall('S12',[[4.4,5.2],[4.4,8.8]],.2,true);
const extension=()=>wall('extension',[[4.3,4.2],[4.3,5.2]],.12);

test('截图反例识别100mm中心线偏移、120/200mm厚度；修复后续接无错台且固定墙不变',()=>{
  const snapshot=JSON.parse(fs.readFileSync(new URL('fixtures/residential-structural-connection.json',import.meta.url),'utf8')) as Pick<SpaceModel,'spaces'|'walls'>;
  const model={...layoutModel(),...snapshot},fixed=model.walls.filter(w=>w.fixed),before=structuredClone(fixed);
  const review=assessStructuralConnections(model);
  assert.equal(review.mismatchCount,1);
  const bad=review.connections.find(c=>!c.aligned)!;
  assert.equal(bad.structuralWallId,'S12');assert.ok(Math.abs(bad.axisOffset-.1)<1e-8);assert.ok(Math.abs(bad.thicknessDifference-.08)<1e-8);
  connectPartitionsToStructure(model.walls.filter(w=>!w.fixed),fixed);
  const repaired=assessStructuralConnections(model);assert.equal(repaired.mismatchCount,0);
  const continued=repaired.connections.find(c=>c.kind==='continuation'&&c.structuralWallId==='S12')!;
  assert.equal(continued.axisOffset,0);assert.ok(continued.thicknessDifference<1e-8);assert.deepEqual(fixed,before);
});

test('直线续接整体对齐中心线并继承厚度，相连的横墙端点一起更新',()=>{
  const fixed=[host()],before=structuredClone(fixed),partitions=[extension(),wall('branch',[[.2,4.2],[4.3,4.2]],.12)];
  connectPartitionsToStructure(partitions,fixed);
  assert.deepEqual(partitions[0].geometry.points,[[4.4,4.2],[4.4,5.2]]);
  assert.equal(partitions[0].thickness,.2);assert.deepEqual(partitions[1].geometry.points.at(-1),[4.4,4.2]);
  assert.equal(partitions[1].thickness,.12);assert.deepEqual(fixed,before);
  connectPartitionsToStructure([...fixed,...partitions],fixed);assert.deepEqual(fixed,before);
});

test('垂直T接保留普通隔墙厚度，几何宿主中心线连接、实际墙面平齐',()=>{
  const fixed=[host()],partition=wall('tee',[[4.5,6],[7,6]],.12);
  connectPartitionsToStructure([partition],fixed);
  assert.deepEqual(partition.geometry.points[0],[4.4,6]);assert.equal(partition.thickness,.12);
  const trims=wallEndTrims(partition,[...fixed,partition]);assert.equal(trims.start.kind,'flush');
  const polygon=wallStripPolygon(partition.geometry.points,partition.thickness,trims.start,trims.end)!;
  assert.ok(Math.abs(Math.min(...polygon.map(p=>p[0]))-4.5)<1e-8);
  const review=assessStructuralConnections({...layoutModel(),walls:[...fixed,partition]});
  assert.equal(review.mismatchCount,0);assert.ok(review.connections.some(c=>c.kind==='tee'&&c.thicknessDifference>.07));
});

test('不会为对齐而跨越实际间隙或把相距较远的平行隔墙吸到承重墙上',()=>{
  const gap=wall('gap',[[4.3,4.2],[4.3,5.1]],.12),distant=wall('far',[[4,4.2],[4,5.2]],.12);
  const before=structuredClone([gap,distant]);connectPartitionsToStructure([gap,distant],[host()]);assert.deepEqual([gap,distant],before);
});

test('续接支持反向、旋转和毫米，固定墙及连接部位始终一致',()=>{
  for(const mode of ['reverse','rotate','mm'] as const) {
    const fixed=[host()],partition=extension();
    if(mode==='reverse'){fixed[0].geometry.points.reverse();partition.geometry.points.reverse();}
    else {
      const transform=(p:Vec2):Vec2=>mode==='mm'?[p[0]*1000,p[1]*1000]:[-p[1],p[0]];
      for(const w of [...fixed,partition]){w.geometry.points=w.geometry.points.map(transform);if(mode==='mm')w.thickness*=1000;}
    }
    const before=structuredClone(fixed);connectPartitionsToStructure([partition],fixed,mode==='mm'?1000:1);
    const model=layoutModel();model.walls=[...fixed,partition];if(mode==='mm')model.model.units='mm';
    const review=assessStructuralConnections(model);assert.equal(review.mismatchCount,0,mode);assert.ok(review.connections.some(c=>c.kind==='continuation'));assert.deepEqual(fixed,before);
  }
});

test('不同厚度转角以真实墙面求交，两面墙共用接合边，无裂缝或重叠',()=>{
  const a=wall('thin',[[0,0],[5,0]],.12),b=wall('thick',[[5,0],[5,4]],.2);
  const polygons=resolveWallJunctions([a,b]),pa=polygons.get(a.id)!,pb=polygons.get(b.id)!;
  for(const ring of [pa,pb])for(const point of [[4.9,.06],[5.1,-.06]])assert.ok(ring.some(p=>Math.hypot(p[0]-point[0],p[1]-point[1])<1e-8));
  assert.ok(geometryArea(intersection([pa],[pb]))<1e-9);
  assert.ok(Math.abs(geometryArea([pa])+geometryArea([pb])-1.4)<1e-8);
});

test('三墙交汇时直线续接优先，支墙按T接裁剪，不受墙数组顺序影响',()=>{
  const south=wall('south',[[0,-2],[0,0]],.2,true),north=wall('north',[[0,0],[0,2]],.2),branch=wall('branch',[[-2,0],[0,0]],.12);
  for(const walls of [[south,north,branch],[branch,north,south],[north,branch,south]]) {
    assert.equal(wallEndTrims(south,walls).end.kind,'butt');assert.equal(wallEndTrims(north,walls).start.kind,'butt');
    const trim=wallEndTrims(branch,walls);assert.equal(trim.end.kind,'flush');assert.equal(trim.end.retreat,.1);
    const ring=wallStripPolygon(branch.geometry.points,branch.thickness,trim.start,trim.end)!;
    assert.ok(Math.abs(Math.max(...ring.map(p=>p[0]))+.1)<1e-8);
  }
});

test('普通隔墙厚度可配置，旧需求默认120mm，非法厚度不能提交',()=>{
  const brief=createResidentialBrief('rev-0001');assert.equal(layoutSettings(brief).partitionThickness,.12);
  brief.layout={...layoutSettings(brief),partitionThickness:.18};assert.equal(layoutSettings(parseResidentialBrief(brief)).partitionThickness,.18);
  brief.layout.partitionThickness=.01;assert.throws(()=>parseResidentialBrief(brief),/隔墙厚度/);
  brief.layout.partitionThickness=NaN;assert.throws(()=>parseResidentialBrief(brief),/隔墙厚度/);
});
