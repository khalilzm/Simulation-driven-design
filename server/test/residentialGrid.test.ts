import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResidentialBrief, createResidentialPreset, layoutSettings, parseResidentialBrief, permitsThrough, type RoomKind, type RoomRequirement } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { buildResidentialGrid, solveResidentialGrid } from '../src/scenarios/residential/residentialGrid';
import { parseResidentialStrategy, residentialStrategyPrompt, type PartitionStrategy } from '../src/scenarios/residential/residentialStrategy';
import { solveResidentialLayout, assessResidentialQuality, ResidentialSolveError } from '../src/scenarios/residential/residentialSolver';
import { validateModel } from '../src/model/validate';
import { validateAgentModel } from '../src/model/validateAgent';
import { validateResidentialCandidate } from '../src/scenarios/residential/residentialBrief';
import { runResidentialTurn } from '../src/scenarios/residential/runResidentialTurn';
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
  const traffic=result.model.spaces.find(s=>s.id==='solver-circulation');
  assert.ok(traffic);
  assert.equal(traffic.enclosed,false,'自动交通区必须是开放公共区域');
  assert.ok(result.report.quality.circulation?.openConnections.some(c=>c.spaceId==='room-living'&&c.netWidthM>=layoutSettings(brief).passageWidth-1e-7));
});

test('用户隔墙厚度参与完整求解，普通隔墙按180mm生成，承重墙续接按宿主厚度',()=>{
  const {base}=setup(),brief=createResidentialPreset('rev-0001','D1');
  brief.layout={...layoutSettings(brief),partitionThickness:.18};
  const strategy={schemaVersion:2 as const,rationale:'明确普通隔墙厚度',roomOrder:brief.rooms.map(r=>r.id),circulation:'auto' as const,preferences:[]};
  const result=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.deepEqual(validateModel(result.model).errors,[]);assert.deepEqual(result.report.quality.errors,[]);
  const continuationIds=new Set(result.report.quality.structuralConnections.connections.filter(c=>c.kind==='continuation').map(c=>c.partitionWallId));
  assert.ok(result.model.walls.some(w=>w.generatedBy&&!continuationIds.has(w.id)));
  for(const wall of result.model.walls.filter(w=>w.generatedBy&&!continuationIds.has(w.id)))assert.ok(Math.abs(wall.thickness-.18)<1e-8);
  for(const connection of result.report.quality.structuralConnections.connections.filter(c=>c.kind==='continuation'))assert.ok(connection.thicknessDifference<1e-8);
  assert.deepEqual(validateResidentialCandidate(result.model,base,{brief,version:1,baseModelHash:'fixture',updatedAt:''}),[]);
});

test('新生成拒绝旧切分协议，格式修复耗尽后终止而不调用旧算法',async t=>{
  const {base,brief}=setup();const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-grid-version-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));let calls=0,solves=0;
  const legacy={schemaVersion:1,rationale:'旧切分',partition:brief.rooms.slice(1).reduce<PartitionStrategy>((a,r)=>({axis:'x',first:a,second:{roomId:r.id}}),{roomId:brief.rooms[0].id}),preferences:[]};
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:{brief,version:1,baseModelHash:'x',updatedAt:''},base},{id:'echo',async run(_input,emit){calls++;emit({type:'text',text:JSON.stringify(legacy)});return {failed:false};}},()=>{},undefined,(...args)=>{solves++;return solveResidentialLayout(...args);});
  assert.equal(result.failed,true);assert.equal(calls,3);assert.equal(solves,0);
  const report=JSON.parse(fs.readFileSync(path.join(cwd,'designs/rev-0002/solver-report.json'),'utf8'));assert.equal(report.failureType,'strategy_format');
});

test('React Flow扩展图坐标与端点可保存，图端点信息不交给布局Agent',()=>{
 const {base,brief}=setup();brief.rooms[0].position={x:-.5,y:1.4};brief.relations[0].diagramHandles={from:'right',to:'left'};
 assert.deepEqual(parseResidentialBrief(brief),brief);assert.doesNotMatch(residentialStrategyPrompt('rev-0002',brief,base),/diagramHandles/);
 assert.throws(()=>parseResidentialBrief({...brief,rooms:[{...brief.rooms[0],position:{x:Infinity,y:0}}]}),/位置/);
 assert.throws(()=>parseResidentialBrief({...brief,relations:[{...brief.relations[0],diagramHandles:{from:'top',to:'left'}}]}),/连接点/);
});

test('七房间套房硬连接在分配阶段保留，窗偏好不能拆散卧室与套卫',()=>{
  const {base,brief}=setup(),byId=new Map(brief.rooms.map(r=>[r.id,r]));
  const main=byId.get('room-main')!,second=byId.get('room-second')!,bath=byId.get('room-bathroom')!,living=byId.get('room-living')!,kitchen=byId.get('room-kitchen')!;
  second.area={min:10,target:14,max:22};
  const balcony={...structuredClone(bath),id:'room-balcony',name:'阳台',kind:'balcony' as const,area:{min:2,target:4,max:8}};
  const bath2={...structuredClone(bath),id:'room-bathroom2',name:'公共卫生间'};
  brief.rooms=[main,second,bath,balcony,living,bath2,kitchen];
  brief.relations=[{id:'rel-entry',from:'entrance:D1',to:living.id,kind:'direct',priority:'hard'},
    ...[main,second,kitchen,balcony,bath2].map((r,i)=>({id:`rel-living-${i}`,from:living.id,to:r.id,kind:'direct' as const,priority:'hard' as const})),
    {id:'rel-suite',from:main.id,to:bath.id,kind:'direct',priority:'hard'}];
  const strategy={schemaVersion:2 as const,rationale:'套房与公共枢纽',roomOrder:[living,main,second,kitchen,balcony,bath,bath2].map(r=>r.id),circulation:'auto' as const,
    preferences:[{roomId:living.id,side:'south' as const,windowId:'W2'},{roomId:main.id,windowId:'W4'},{roomId:second.id,windowId:'W3'},{roomId:kitchen.id,windowId:'W1'},{roomId:balcony.id,side:'south' as const},{roomId:bath.id,windowId:'W5'},{roomId:bath2.id,side:'north' as const}]};
  const before=structuredClone(brief),solved=solveResidentialGrid(base,brief,strategy,'rev-0002');
  assert.deepEqual(solved.report.quality.errors,[]);assert.deepEqual(validateModel(solved.model).errors,[]);assert.deepEqual(validateAgentModel(solved.model).errors,[]);
  assert.deepEqual(validateResidentialCandidate(solved.model,base,{brief,version:1,baseModelHash:'x',updatedAt:''}),[]);
  assert.ok(solved.report.checks.some(c=>c.includes('rel-suite')));assert.ok(Object.keys(solved.report.earlyConnectionPrunes).some(k=>k.includes('room-main↔room-bathroom')));
  assert.deepEqual(brief,before);
});

test('搜索超时带具体硬连接冲突进入策略重试，第二轮可正常交付',async t=>{
  const {base,brief,strategy}=setup(),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-grid-time-retry-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  let calls=0,solves=0;
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:{brief,version:1,baseModelHash:'x',updatedAt:''},base},{id:'echo',async run(input,emit){
    if(++calls===2){assert.match(input.message,/time_budget/);assert.match(input.message,/具体搜索冲突/);assert.match(input.message,/客餐厅.*厨房/);assert.match(input.message,/布局第1轮/);}
    emit({type:'text',text:JSON.stringify(strategy)});return {failed:false};
  }},()=>{},undefined,(...args)=>{
    if(++solves===1)throw new ResidentialSolveError('20秒预算内未找到布局，不能认定无解',{status:'time_budget',failures:[{reason:'客餐厅↔厨房：未保留可开门的共享边界',count:12}]});
    return solveResidentialLayout(...args);
  });
  assert.equal(result.failed,false);assert.equal(calls,2);assert.equal(solves,2);
  const folder=path.join(cwd,'designs/rev-0002');assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'solver-attempt-1.json'),'utf8')).failureType,'time_budget');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'generation-state.json'),'utf8')).status,'completed');
});

test('连续搜索超时最多三个布局轮次，不无限重试，也不放宽需求',async t=>{
  const {base,brief,strategy}=setup(),snapshot=structuredClone(brief),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-grid-time-limit-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));let calls=0,solves=0;
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:{brief,version:1,baseModelHash:'x',updatedAt:''},base},{id:'echo',async run(input,emit){
    calls++;if(calls===3){assert.match(input.message,/布局第1轮/);assert.match(input.message,/布局第2轮/);}
    emit({type:'text',text:JSON.stringify(strategy)});return {failed:false};
  }},()=>{},undefined,()=>{solves++;throw new ResidentialSolveError('搜索预算耗尽',{status:'time_budget'});});
  assert.equal(result.failed,true);assert.equal(calls,3);assert.equal(solves,3);assert.deepEqual(brief,snapshot);
  const state=JSON.parse(fs.readFileSync(path.join(cwd,'designs/rev-0002/generation-state.json'),'utf8'));assert.equal(state.status,'failed');assert.equal(state.attempt,3);
});
