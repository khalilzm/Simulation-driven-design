import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createResidentialBrief, type SpaceModel, type Vec2 } from '@sdd/shared';
import { assessWallAlignment, rectangleAlignmentOffset } from '../src/scenarios/residential/wallAlignment';
import { compareResidentialScores } from '../src/scenarios/residential/residentialGrid';
import { rectangle, layoutModel } from './helpers/spaceModel';

const snapshot=JSON.parse(fs.readFileSync(new URL('fixtures/residential-wall-step.json',import.meta.url),'utf8')) as Pick<SpaceModel,'spaces'|'walls'>;

test('上一轮方案的阳台厨房错位准确报告为0.40m，同侧共线墙不产生台阶',()=>{
  const model={...layoutModel(),...structuredClone(snapshot)};
  const result=assessWallAlignment(model,createResidentialBrief('rev-0001'));
  assert.equal(result.steps.length,1);assert.ok(Math.abs(result.totalOffset-.4)<1e-8);
  assert.deepEqual(result.steps[0].wallIds,['grid-wall-7','grid-wall-6']);
  assert.match(result.warnings[0],/错位0.40m/);
});

function stepModel(lowerAt=3.2,upperAt=2.8,lowerThickness=.12,upperThickness=.12):SpaceModel {
  const model=layoutModel();model.floor.boundary=rectangle(0,0,8,5);
  const rightLow=lowerAt+lowerThickness/2,rightHigh=upperAt+upperThickness/2;
  model.spaces=[{...model.spaces[0],id:'room-living',usage:'客餐厅',boundary:[[rightLow,0],[8,0],[8,5],[rightHigh,5],[rightHigh,2.26],[rightLow,2.26],[rightLow,0]]}];
  const wall=(id:string,points:Vec2[],thickness:number)=>({id,geometry:{type:'polyline' as const,points},thickness,height:3,fixed:false,role:'partition' as const,generatedBy:'layout-grid-v1' as const});
  model.walls=[wall('lower',[[lowerAt,0],[lowerAt,2.2]],lowerThickness),wall('upper',[[upperAt,2.2],[upperAt,4.2]],upperThickness),wall('connector',[[lowerAt,2.2],[upperAt,2.2]],.12)];
  return model;
}

test('按墙面判断对齐：墙厚不同但墙面相齐时不惩罚；固定墙不被要求移动',()=>{
  const brief=createResidentialBrief('rev-0001');
  assert.equal(assessWallAlignment(stepModel(3.2,3.2),brief).totalOffset,0);
  assert.equal(assessWallAlignment(stepModel(3.2,3.24,.2,.12),brief).totalOffset,0);
  const fixed=stepModel();fixed.walls[0].fixed=true;
  assert.equal(assessWallAlignment(fixed,brief).totalOffset,0);
});

test('缺少连接横墙、墙端不连续、长距离功能分区均不作为短台阶误报',()=>{
  const brief=createResidentialBrief('rev-0001'),unconnected=stepModel();unconnected.walls.pop();
  assert.equal(assessWallAlignment(unconnected,brief).totalOffset,0);
  const separated=stepModel();separated.walls[1].geometry.points[0][1]=3;
  assert.equal(assessWallAlignment(separated,brief).totalOffset,0);
  assert.equal(assessWallAlignment(stepModel(4.2,2.8),brief).totalOffset,0);
});

test('台阶检查支持横竖方向、反向墙线及毫米，结果一致',()=>{
  const brief=createResidentialBrief('rev-0001');
  for(const mode of ['reverse','rotate','mm'] as const) {
    const model=stepModel();
    if(mode==='reverse')model.walls.forEach(w=>w.geometry.points.reverse());
    else {
      const transform=(p:Vec2):Vec2=>mode==='mm'?[p[0]*1000,p[1]*1000]:[-p[1],p[0]];
      model.floor.boundary=model.floor.boundary.map(transform);model.spaces.forEach(s=>s.boundary=s.boundary.map(transform));
      model.walls.forEach(w=>{w.geometry.points=w.geometry.points.map(transform);if(mode==='mm')w.thickness*=1000;});
      if(mode==='mm')model.model.units='mm';
    }
    assert.ok(Math.abs(assessWallAlignment(model,brief).totalOffset-.4)<1e-8,mode);
  }
});

test('分配阶段只比较邻接矩形的短错位，最终对齐优先于面积朝向偏好',()=>{
  const lower={minX:.2,maxX:3.2,minY:.2,maxY:2.2};
  const upper={minX:.2,maxX:2.8,minY:2.2,maxY:4.2};
  assert.ok(Math.abs(rectangleAlignmentOffset(lower,upper,.9)-.4)<1e-8);
  assert.equal(rectangleAlignmentOffset(lower,{...upper,minY:3},.9),0);
  assert.equal(rectangleAlignmentOffset(lower,{...upper,maxX:3.2},.9),0);
  const aligned={wallRelationships:0,wallAlignment:0,publicFragmentation:.3,preferences:100};
  assert.ok(compareResidentialScores(aligned,{wallRelationships:0,wallAlignment:.4,publicFragmentation:.1,preferences:0})<0);
  assert.ok(compareResidentialScores(aligned,{wallRelationships:1,wallAlignment:0,publicFragmentation:.1,preferences:0})<0);
});
