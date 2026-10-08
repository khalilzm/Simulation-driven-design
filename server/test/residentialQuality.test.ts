import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceModel, Vec2, Wall } from '@sdd/shared';
import { assessRoomQuality, doorApron, structuralGapErrors, swingFootprint, swingCollision } from '../src/design/residentialQuality';
import { rectangle } from '../src/design/regionGeometry';
const wall=(id:string,x:number,fixed=false):Wall=>({id,geometry:{type:'polyline',points:[[x,.2],[x,3]]},thickness:fixed?.2:.12,height:3,fixed,role:fixed?'structural':'partition'});

test('56cm承重墙夹缝拒绝；对齐承重墙或留下充分净宽通过',()=> {
  const host=wall('S11',4.4,true);
  assert.match(structuralGapErrors([wall('new',3.68)],[host])[0],/0.56m夹缝/);
  assert.deepEqual(structuralGapErrors([wall('aligned',4.4)],[host]),[]);
  assert.deepEqual(structuralGapErrors([wall('wide',3.1)],[host]),[]);
});
test('15cm连接的卧室尾部不能计入有效面积；毫米与米结果一致',()=> {
  const polygon:Vec2[]=[[3.74,.2],[4.3,.2],[4.3,3],[4.5,3],[4.5,.2],[9.0718,.2],[9.0718,3.15],[3.74,3.15],[3.74,.2]];
  const quality=assessRoomQuality(polygon,'bedroom');
  assert.ok(quality.tailArea>1);assert.ok(quality.errors.some(e=>e.includes('尾部')));
  const mm=assessRoomQuality(polygon.map(p=>[p[0]*1000,p[1]*1000]),'bedroom',1000);
  assert.ok(Math.abs(mm.tailArea-quality.tailArea)<1e-6);
});
test('两个宽房间用窄颈连接仍拒绝；正常房间没有虚假无效角落',()=> {
  const polygon:Vec2[]=[[0,0],[3,0],[3,1.4],[4,1.4],[4,0],[7,0],[7,3],[4,3],[4,1.6],[3,1.6],[3,3],[0,3],[0,0]];
  assert.ok(assessRoomQuality(polygon,'bedroom').errors.some(e=>e.includes('窄颈')));
  const ordinary=assessRoomQuality(rectangle(0,0,3,4),'bedroom');
  assert.deepEqual(ordinary.errors,[]);assert.equal(ordinary.tailArea,0);
  assert.ok(assessRoomQuality(rectangle(0,0,1.7,8),'bedroom').errors.some(e=>e.includes('房间主体')));
});
test('门前矩形必须完整落入房间，不以门两侧标签代替可通行空间',()=> {
  const model={model:{units:'m'},spaces:[{id:'narrow',boundary:rectangle(.06,0,.62,4)},{id:'wide',boundary:rectangle(-3,0,-.06,4)}]} as SpaceModel;
  const host={...wall('door',0),geometry:{type:'polyline' as const,points:[[0,0],[0,4]] as Vec2[]}};
  assert.deepEqual(doorApron(model,host,2,.9).map(a=>a.roomId),['wide']);
  model.spaces[0].boundary=rectangle(.06,0,3,4);
  assert.equal(doorApron(model,host,2,.9).length,2);
});
test('垂直墙角门扇开启冲突检测，分开的门扇允许',()=> {
  const model={model:{units:'m'}} as SpaceModel;
  const horizontal={...wall('a',0),geometry:{type:'polyline' as const,points:[[0,0],[4,0]] as Vec2[]}};
  const vertical={...wall('b',0),geometry:{type:'polyline' as const,points:[[0,0],[0,4]] as Vec2[]}};
  const a=swingFootprint(model,horizontal,.5,.9,'left');
  const b=swingFootprint(model,vertical,.5,.9,'right','end');
  assert.equal(swingCollision(a,b),true);
  assert.equal(swingCollision(a,swingFootprint(model,horizontal,3,.9,'left')),false);
});
