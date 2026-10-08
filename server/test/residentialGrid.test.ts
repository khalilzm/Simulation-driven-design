import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResidentialBrief, createResidentialPreset, layoutSettings, parseResidentialBrief, permitsThrough, type RoomKind, type RoomRequirement } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { buildResidentialGrid } from '../src/design/residentialGrid';
import { parseResidentialStrategy, residentialStrategyPrompt, type PartitionStrategy } from '../src/design/residentialStrategy';
import { solveResidentialLayout, assessResidentialQuality, ResidentialSolveError } from '../src/design/residentialSolver';
import { validateModel } from '../src/model/validate';
import { validateAgentModel } from '../src/model/validateAgent';
import { validateResidentialCandidate } from '../src/design/residentialBrief';
import { runResidentialTurn } from '../src/design/runResidentialTurn';
const fixture=fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf',import.meta.url),'utf8');
function setup() {
  const base=parseFixedEnvelopeDxf(fixture,'fixed.dxf');base.model.revisionId='rev-0001';
  const brief=createResidentialBrief('rev-0001');
  const room=(id:string,kind:RoomKind,area:[number,number,number]):RoomRequirement=>({id,name:id,kind,area:{min:area[0],target:area[1],max:area[2]},window:kind==='bedroom'?'required':'preferred',sunlight:{enabled:kind==='bedroom',minHours:2,minAreaRatio:.5,priority:'soft'},position:{x:.1,y:.9}});
  brief.rooms=[room('room-main','bedroom',[10,14,22]),room('room-living','living',[20,28,40]),room('room-second','bedroom',[10,14,22]),room('room-bathroom','bathroom',[3,5,8]),room('room-kitchen','kitchen',[5,7,12]),room('room-study','study',[5,9,18])];
  brief.relations=brief.rooms.map((r,i)=>({id:`rel-entry-${i}`,from:'entrance:D1',to:r.id,kind:r.kind==='living'?'direct' as const:'public_access' as const,priority:'hard' as const}));
  brief.relations.push({id:'rel-living-kitchen',from:'room-living',to:'room-kitchen',kind:'direct',priority:'hard'},{id:'rel-kitchen-main',from:'room-kitchen',to:'room-main',kind:'no_direct',priority:'hard'},{id:'rel-kitchen-second',from:'room-kitchen',to:'room-second',kind:'no_direct',priority:'hard'});
  const strategy={schemaVersion:2 as const,rationale:'窗与通路联合分配',roomOrder:brief.rooms.map(r=>r.id),circulation:'auto' as const,preferences:[]};
  return {base,brief,strategy};
}
test('意图协议不接收切分树，顺序恰好覆盖全部节点；prompt不强加房间主体尺寸',()=>{
  const {base,brief,strategy}=setup();assert.deepEqual(parseResidentialStrategy(strategy,brief,base),strategy);
  assert.throws(()=>parseResidentialStrategy({...strategy,partition:{}},brief,base),/切分树/);
  assert.throws(()=>parseResidentialStrategy({...strategy,roomOrder:[]},brief,base),/全部/);
  assert.throws(()=>parseResidentialStrategy({...strategy,preferences:[{roomId:'room-main',windowId:'unknown'}]},brief,base),/未知固定窗/);
  const prompt=residentialStrategyPrompt('rev-0002',brief,base);assert.doesNotMatch(prompt,/2.4×2.7|1.8×2|3×3|Tree 是/);assert.match(prompt,/schemaVersion:2/);
});
test('旧需求兼容明确默认值，用户可编辑通行参数、穿行许可与主体尺寸',()=>{
  const {brief}=setup();assert.equal(layoutSettings(brief).gridSize,.5);assert.equal(permitsThrough(brief.rooms[0]),false);
  brief.rooms[0].allowThrough=true;brief.rooms[0].bodySize=[2.1,2.3];brief.layout={gridSize:.4,passageWidth:.8,doorWidth:.8,doorDepth:1};
  assert.deepEqual(parseResidentialBrief(brief),brief);assert.equal(permitsThrough(brief.rooms[0]),true);
  assert.throws(()=>parseResidentialBrief({...brief,layout:{...brief.layout,gridSize:0}}),/布局参数/);
});
test('网格细化保留真实承重墙厚度，墙两侧不能当作一个可用矩形',()=>{
  const {base}=setup(),g=buildResidentialGrid(base,.5);
  assert.ok(g.xs.includes(4.3));assert.ok(g.xs.includes(4.5));
  const x0=g.xs.indexOf(4.3),x1=g.xs.indexOf(4.5),y0=g.ys.indexOf(.2),y1=g.ys.indexOf(3);
  assert.equal(g.clear(x0,y0,x1,y1),false);assert.ok(g.freeCells>0);
});
test('六房间网格联合求解通过完整模型、固定构件、面积、窗及硬关系验证，图坐标不决定几何',()=>{
  const {base,brief,strategy}=setup(),snapshot=structuredClone(base);
  const solved=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.equal(solved.report.method,'obstacle-grid-allocation');assert.ok(solved.report.candidateCount>=1);assert.deepEqual(solved.report.quality.errors,[]);
  assert.deepEqual(validateModel(solved.model).errors,[]);assert.deepEqual(validateAgentModel(solved.model).errors,[]);
  assert.deepEqual(validateResidentialCandidate(solved.model,base,{brief,version:1,baseModelHash:'test',updatedAt:''}),[]);
  assert.deepEqual(base,snapshot);for(const key of ['walls','openings','doors','windows'] as const)for(const item of base[key])assert.deepEqual(solved.model[key].find(x=>x.id===item.id),item);
  assert.ok(solved.model.walls.some(w=>w.generatedBy==='layout-grid-v1'));assert.ok(solved.model.doors.length>base.doors.length);
  brief.rooms.forEach(r=>r.position={x:.99,y:.01});assert.deepEqual(solveResidentialLayout(base,brief,strategy,'rev-0002').model,solved.model);
});
test('没有用户主体尺寸时旧硬尺寸只作为品质提示；显式指定的主体仍必须满足',()=>{
  const {base,brief}=setup();base.spaces=[{id:'room-main',allocationId:'room-main',usage:'room-main',typeId:'test-type',boundary:[[.2,.2],[1.9,.2],[1.9,8],[.2,8],[.2,.2]],enclosed:true,targetArea:14,performancePreferences:{}}];
  const quality=assessResidentialQuality(base,brief,{},true);assert.ok(!quality.errors.some(e=>e.includes('无法容纳')));
  brief.rooms[0].bodySize=[2.4,2.7];assert.ok(assessResidentialQuality(base,brief,{},true).errors.some(e=>e.includes('无法容纳')));
});
test('布局失败信息跨格式修复保留；格式修复不消耗三个布局轮次',async t=>{
  const {base,brief,strategy}=setup();
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-grid-retry-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  let calls=0,solverCalls=0;
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:{brief,version:1,baseModelHash:'x',updatedAt:''},base},{id:'echo',async run(input,emit){
    calls++;if(calls===3){assert.match(input.message,/已知布局冲突/);assert.match(input.message,/布局第1轮/);}
    if(calls===4){assert.match(input.message,/布局第1轮/);assert.match(input.message,/布局第2轮/);}
    emit({type:'text',text:calls===2?'{"schemaVersion":':JSON.stringify(strategy)});return {failed:false};
  }},()=>{},undefined,(...args)=>{
    if(++solverCalls<3)throw new ResidentialSolveError('测试的布局组合未找到解',{status:'search_exhausted'});
    return solveResidentialLayout(...args);
  });
  assert.equal(result.failed,false);assert.equal(calls,4);const state=JSON.parse(fs.readFileSync(path.join(cwd,'designs/rev-0002/generation-state.json'),'utf8'));assert.equal(state.attempt,3);
});

test('默认两居一卫预设直接走v2网格流程；交通按需而非必备',()=>{
  const {base}=setup(),brief=createResidentialPreset('rev-0001','D1');
  const strategy={schemaVersion:2 as const,rationale:'默认住宅',roomOrder:brief.rooms.map(r=>r.id),circulation:'auto' as const,preferences:[]};
  const result=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.deepEqual(result.report.quality.errors,[]);assert.deepEqual(validateModel(result.model).errors,[]);
  for(const r of brief.rooms)assert.ok(result.model.spaces.some(s=>s.id===r.id));
  assert.ok(result.report.checks.filter(c=>c.includes('public_access')).length>=4);
});

test('新生成拒绝旧切分协议，格式修复耗尽后终止而不调用旧算法',async t=>{
  const {base,brief}=setup();const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-grid-version-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));let calls=0,solves=0;
  const legacy={schemaVersion:1,rationale:'旧切分',partition:brief.rooms.slice(1).reduce<PartitionStrategy>((a,r)=>({axis:'x',first:a,second:{roomId:r.id}}),{roomId:brief.rooms[0].id}),preferences:[]};
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:{brief,version:1,baseModelHash:'x',updatedAt:''},base},{id:'echo',async run(_input,emit){calls++;emit({type:'text',text:JSON.stringify(legacy)});return {failed:false};}},()=>{},undefined,(...args)=>{solves++;return solveResidentialLayout(...args);});
  assert.equal(result.failed,true);assert.equal(calls,3);assert.equal(solves,0);
  const report=JSON.parse(fs.readFileSync(path.join(cwd,'designs/rev-0002/solver-report.json'),'utf8'));assert.equal(report.failureType,'strategy_format');
});
