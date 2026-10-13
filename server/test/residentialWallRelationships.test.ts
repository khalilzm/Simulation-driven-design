import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkResidentialBrief, parseResidentialBrief, type ResidentialBrief, type SpaceModel, type Vec2 } from '@sdd/shared';
import { assessStructuralWallRelationships } from '../src/scenarios/residential/structuralWallRelationships';
import { largestRoomRectangle } from '../src/scenarios/residential/publicSpaceQuality';
import { assessResidentialQuality } from '../src/scenarios/residential/residentialSolver';
import { compareResidentialScores, solveResidentialGrid } from '../src/scenarios/residential/residentialGrid';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { type IntentResidentialStrategy } from '../src/scenarios/residential/residentialStrategy';
import { validateResidentialCandidate } from '../src/scenarios/residential/residentialBrief';
import { validateModel } from '../src/model/validate';
import { validateAgentModel } from '../src/model/validateAgent';
import { geometryArea, intersection, rectangle } from '../src/geometry/regions';

const fixture=JSON.parse(fs.readFileSync(new URL('fixtures/residential-protruding-wall.json',import.meta.url),'utf8')) as {model:SpaceModel;brief:ResidentialBrief;strategy:IntentResidentialStrategy};
function baseModel() {
  const base=parseFixedEnvelopeDxf(fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf',import.meta.url),'utf8'),'fixed.dxf');
  base.model.revisionId='rev-0001';return base;
}

test('截图反例：原检查认可的客餐厅，准确识别S12的1.94m同空间墙段及接合区间',()=>{
  const quality=assessResidentialQuality(fixture.model,fixture.brief,{},true);
  assert.deepEqual(quality.errors,[]); // feasible geometry can still have poor wall relationships
  const wall=quality.structuralWalls.walls.find(w=>w.wallId==='S12')!;
  assert.ok(Math.abs(wall.unexplainedLength-1.94)<1e-8);
  assert.ok(Math.abs(wall.separatorLength-1.54)<1e-8);
  assert.deepEqual(wall.intervals.map(i=>i.status),['same_space','junction','separator']);
  assert.ok(Math.abs(wall.intervals[1].length-.12)<1e-8);
  assert.match(quality.warnings.join('\n'),/S12.*1.94m.*客餐厅1/);
  const living=quality.publicSpaces[0];
  assert.ok(Math.abs(living.coreArea-14.6256)<1e-8);assert.ok(living.coreRatio<.4);
  assert.ok(Math.abs(quality.structuralWalls.walls.find(w=>w.wallId==='S11')!.unexplainedLength)<1e-8);
});

test('墙面归属检查不依赖米/毫米、墙线方向或旋转，不把外围墙当成外露内墙',()=>{
  const expected=assessStructuralWallRelationships(fixture.model,fixture.brief);
  for(const mode of ['mm','reverse','rotate'] as const) {
    const model=structuredClone(fixture.model);
    if(mode==='reverse')model.walls.forEach(w=>w.geometry.points.reverse());
    else {
      const transform=(p:Vec2):Vec2=>mode==='mm'?[p[0]*1000,p[1]*1000]:[(p[0]-p[1])*Math.SQRT1_2,(p[0]+p[1])*Math.SQRT1_2];
      model.floor.boundary=model.floor.boundary.map(transform);
      model.spaces.forEach(s=>s.boundary=s.boundary.map(transform));
      model.walls.forEach(w=>{w.geometry.points=w.geometry.points.map(transform);if(mode==='mm')w.thickness*=1000;});
      if(mode==='mm')model.model.units='mm';
    }
    const review=assessStructuralWallRelationships(model,fixture.brief);
    assert.ok(Math.abs(review.unexplainedLength-expected.unexplainedLength)<1e-8,mode);
    assert.deepEqual(review.walls.map(w=>w.wallId),['S11','S12']);
  }
});

test('用户明确保留的开放空间墙垛仍报告实际长度，但不惩罚；用途不能指向未知墙体',()=>{
  const brief=structuredClone(fixture.brief);brief.structuralWallUses=[{wallId:'S12',purpose:'客餐厅开放分区的展示墙'}];
  const before=structuredClone(fixture.model),review=assessStructuralWallRelationships(fixture.model,brief);
  assert.equal(review.unexplainedLength,0);assert.deepEqual(review.warnings,[]);
  assert.ok(Math.abs(review.walls.find(w=>w.wallId==='S12')!.sameSpaceLength-1.94)<1e-8);
  assert.ok(review.walls.find(w=>w.wallId==='S12')!.intervals.some(i=>i.status==='intentional'));
  assert.deepEqual(fixture.model,before);assert.deepEqual(parseResidentialBrief(brief),brief);
  const base=baseModel();assert.deepEqual(checkResidentialBrief(brief,base).filter(i=>i.level==='error'),[]);
  brief.structuralWallUses[0].wallId='unknown';assert.ok(checkResidentialBrief(brief,base).some(i=>i.message.includes('未知固定承重墙')));
  brief.structuralWallUses=[{wallId:'S12',purpose:''}];assert.throws(()=>parseResidentialBrief(brief),/明确用途/);
  brief.structuralWallUses=[{wallId:'S12',purpose:'展示墙'},{wallId:'S12',purpose:'重复'}];assert.throws(()=>parseResidentialBrief(brief),/唯一墙体/);
});

test('最大完整矩形不会跨越L形凹口；普通矩形无碎片惩罚；斜边不靠中心点误判',()=>{
  assert.equal(largestRoomRectangle(rectangle(0,0,4,5)).area,20);
  const l:Vec2[]=[[0,0],[5,0],[5,2],[2,2],[2,5],[0,5],[0,0]];
  const core=largestRoomRectangle(l);assert.equal(core.area,10);
  assert.ok(Math.abs(geometryArea(intersection([l],[core.boundary]))-core.area)<1e-8);
  const triangle:Vec2[]=[[0,0],[4,0],[4,4],[0,0]];
  const diagonal=largestRoomRectangle(triangle);
  assert.ok(diagonal.area<8);
});

test('墙体关系和公共主体先于朝向面积偏好，微小接合噪声不改变选择',()=>{
  const tidy={wallRelationships:0,publicFragmentation:.3,preferences:100};
  assert.ok(compareResidentialScores(tidy,{wallRelationships:1.94,publicFragmentation:.1,preferences:0})<0);
  assert.ok(compareResidentialScores(tidy,{wallRelationships:0,publicFragmentation:.6,preferences:0})<0);
  assert.ok(compareResidentialScores({...tidy,wallRelationships:.001,preferences:0},tidy)<0);
});

test('同一截图需求重新求解：墙段用途完整、客餐厅主体改善、固定构件及套房硬关系保留',()=>{
  const base=baseModel(),snapshot=structuredClone(base),brief=structuredClone(fixture.brief),before=structuredClone(brief);
  const result=solveResidentialGrid(base,brief,fixture.strategy,'rev-0020');
  assert.equal(result.report.qualityChecksVersion,6);
  assert.equal(result.report.quality.structuralConnections.mismatchCount,0);
  // The solver may separate S12 with a corner or a continuation; both must join correctly.
  const connections=result.report.quality.structuralConnections.connections;
  const connection=connections.find(c=>c.structuralWallId==='S12');
  assert.ok(connection);assert.equal(connection.axisOffset,0);assert.equal(connection.aligned,true);
  const continuations=connections.filter(c=>c.kind==='continuation');
  assert.ok(continuations.length>0);
  for(const c of continuations){assert.equal(c.axisOffset,0);assert.ok(c.thicknessDifference<1e-8);}
  const s12=result.report.quality.structuralWalls.walls.find(w=>w.wallId==='S12')!;
  assert.ok(s12.separatorLength>3);assert.equal(s12.unexplainedLength,0);
  assert.ok(result.report.quality.wallAlignment.totalOffset<.02);
  const balcony=result.model.spaces.find(s=>s.usage==='阳台1')!,kitchen=result.model.spaces.find(s=>s.usage==='厨房1')!;
  assert.ok(Math.abs(Math.max(...balcony.boundary.map(p=>p[0]))-Math.max(...kitchen.boundary.map(p=>p[0])))<1e-8,'阳台和厨房朝向公共区的墙面应连续对齐');
  assert.ok(result.report.quality.structuralWalls.unexplainedLength<.05);
  const living=result.report.quality.publicSpaces[0];assert.ok(living.coreRatio>.6);
  const core=result.report.publicCore;
  assert.ok(Math.abs(geometryArea(intersection([result.model.spaces.find(s=>s.id===living.spaceId)!.boundary],[core.boundary]))-core.area)<1e-6);
  assert.deepEqual(result.report.quality.errors,[]);
  assert.deepEqual(validateModel(result.model).errors,[]);assert.deepEqual(validateAgentModel(result.model).errors,[]);
  assert.deepEqual(validateResidentialCandidate(result.model,base,{brief,version:1,baseModelHash:'fixture',updatedAt:''}),[]);
  assert.equal(result.report.checks.length,brief.relations.length);
  assert.deepEqual(base,snapshot);assert.deepEqual(brief,before);
  for(const key of ['walls','openings','doors','windows'] as const)for(const item of base[key])assert.deepEqual(result.model[key].find(x=>x.id===item.id),item);
});
