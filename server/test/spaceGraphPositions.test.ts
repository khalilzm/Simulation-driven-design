import {test} from 'node:test';
import assert from 'node:assert/strict';
import {committedGraphPositions} from '../../web/src/components/spaceGraphPositions';
test('拖拽中不回写需求，松开后一次提交所有房间的位置，固定入户不能回写',()=>{
 const rooms=new Set(['room-a','room-b']);
 assert.deepEqual(committedGraphPositions([{id:'room-a',type:'position',position:{x:400,y:300},dragging:true}],rooms),[]);
 assert.deepEqual(committedGraphPositions([{id:'room-a',type:'position',position:{x:420,y:350},dragging:false},{id:'room-b',type:'position',position:{x:600,y:490},dragging:false},{id:'entrance:D1',type:'position',position:{x:200,y:200},dragging:false}],rooms),[{id:'room-a',x:.42,y:.5},{id:'room-b',x:.6,y:.7}]);
});
test('键盘移动仍可提交；选择及尺寸事件不会改变需求位置',()=>{
 const rooms=new Set(['room-a']);
 assert.deepEqual(committedGraphPositions([{id:'room-a',type:'position',position:{x:-20,y:700}},{id:'room-a',type:'select',selected:true},{id:'room-a',type:'dimensions',dimensions:{width:158,height:84}}],rooms),[{id:'room-a',x:-.02,y:1}]);
});
