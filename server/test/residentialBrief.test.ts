import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { briefSunlightConfig, checkResidentialBrief, createResidentialBrief, createResidentialPreset, entranceNodeId, parseResidentialBrief,
  type ResidentialBrief, type RoomRequirement, type StreamEvent } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { saveDesign, loadDesign, isAcceptedDesign } from '../src/model/store';
import { workspacesDir } from '../src/config';
import { loadResidentialBrief, prepareResidentialGeneration, saveResidentialBrief, validateResidentialCandidate } from '../src/scenarios/residential/residentialBrief';
import { handleSpaceTurn } from '../src/routes/spaceTurn';
import { echoAdapter } from '../src/providers/echo';
import type { ChatTurnInput } from '../src/providers/types';
import { buildSpatialGraph, reachableFrom } from '../src/geometry/spatialGraph';
import { RESIDENTIAL_SCENARIO } from '@sdd/shared';

const fixture = fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf',import.meta.url),'utf8');
const room = (): RoomRequirement => ({id:'room-main',name:'主卧',kind:'bedroom',area:{min:10,target:14,max:30},window:'required',
  sunlight:{enabled:true,minHours:2,minAreaRatio:0.5,priority:'hard'},position:{x:0.6,y:0.3}});
function setup(t: TestContext) {
  const sessionId=`test-brief-${randomUUID()}`;
  t.after(() => fs.rmSync(path.join(workspacesDir,sessionId),{recursive:true,force:true}));
  const {revisionId}=saveDesign(sessionId,parseFixedEnvelopeDxf(fixture,'house.dxf'));
  const model=loadDesign(sessionId,revisionId)!;
  const brief=createResidentialBrief(revisionId);brief.rooms=[room()];
  brief.relations=[{id:'rel-entry',from:entranceNodeId('D1'),to:'room-main',kind:'public_access',priority:'hard'}];
  return {sessionId,revisionId,model,brief};
}

test('首次住宅底图预填两居一卫；真实入户绑定，保存后不覆盖自定义或空需求', (t) => {
  const {sessionId,revisionId,model}=setup(t);
  const initial=loadResidentialBrief(sessionId,revisionId).document;
  assert.deepEqual(initial.brief,createResidentialPreset(revisionId,'D1'));
  assert.equal(initial.brief.rooms.length,5);
  assert.equal(initial.brief.relations.length,9);
  assert.deepEqual(parseResidentialBrief(initial.brief),initial.brief);
  assert.equal(checkResidentialBrief(initial.brief,model).filter(i=>i.level==='error').length,0);
  assert.deepEqual(briefSunlightConfig(initial.brief).targets,[{spaceIds:['room-main'],minHours:2},{spaceIds:['room-second'],minHours:2}]);
  assert.ok(initial.brief.rooms.filter(r=>r.kind==='bedroom').every(r=>r.sunlight.priority==='soft'&&r.sunlight.minAreaRatio===.5));
  const empty=createResidentialBrief(revisionId);
  const saved=saveResidentialBrief(sessionId,revisionId,{brief:empty,expectedVersion:0,baseModelHash:initial.baseModelHash});
  assert.deepEqual(loadResidentialBrief(sessionId,revisionId).document,saved);
  assert.equal(createResidentialPreset(revisionId).relations.some(r=>r.from.startsWith('entrance:')),false);
});

test('需求身份和节点图坐标独立于几何；日照目标绑定稳定 room ID', (t) => {
  const {brief,model}=setup(t);
  const parsed=parseResidentialBrief(brief);
  assert.deepEqual(parsed,brief);
  assert.equal(checkResidentialBrief(brief,model).filter((i) => i.level==='error').length,0);
  assert.deepEqual(briefSunlightConfig(brief).targets,[{spaceIds:['room-main'],minHours:2}]);
  parsed.rooms[0].position={x:0.1,y:0.9};
  assert.deepEqual(briefSunlightConfig(parsed),briefSunlightConfig(brief));
  assert.equal(model.spaces.length,0);
});

test('检查关系冲突、悬空节点、面积超限、未知入户及无效采光目标', (t) => {
  const {brief,model}=setup(t);
  const second=room();second.id='room-second';second.name='次卧';brief.rooms.push(second);
  brief.relations.push({id:'rel-a',from:'room-main',to:'room-second',kind:'direct',priority:'hard'},
    {id:'rel-b',from:'room-main',to:'room-second',kind:'no_direct',priority:'hard'});
  assert.ok(checkResidentialBrief(brief,model).some((i) => i.message.includes('同时')));
  brief.relations.pop();brief.relations[0].from='entrance:missing';
  assert.ok(checkResidentialBrief(brief,model).some((i) => i.message.includes('当前底图')));
  brief.rooms[0].sunlight.minHours=10;
  assert.ok(!checkResidentialBrief(brief,model).some((i) => i.message.includes('分析时段')));
  brief.rooms[0].daylight={enabled:true,minIlluminanceLux:-1,minAreaRatio:.5,priority:'soft'};
  assert.throws(()=>parseResidentialBrief(brief),/采光目标无效/);
  brief.rooms[0].daylight.minIlluminanceLux=300;
  brief.rooms.forEach((r) => {r.area={min:70,target:70,max:80};});
  assert.ok(checkResidentialBrief(brief,model).some((i) => i.message.includes('超过轮廓')));
  brief.relations[0].to='room-deleted';
  assert.throws(() => parseResidentialBrief(brief),/不存在/);
});

test('需求版本持久化且拒绝旧写入、变化底图及未保存任务', (t) => {
  const {sessionId,revisionId,brief}=setup(t);
  const initial=loadResidentialBrief(sessionId,revisionId).document;
  assert.equal(initial.version,0);
  assert.throws(() => prepareResidentialGeneration(sessionId,{baseRevisionId:revisionId,version:0,baseModelHash:initial.baseModelHash}),/尚未保存/);
  const saved=saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:0,baseModelHash:initial.baseModelHash});
  assert.equal(saved.version,1);assert.deepEqual(loadResidentialBrief(sessionId,revisionId).document,saved);
  assert.throws(() => saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:0,baseModelHash:initial.baseModelHash}),/已变化/);
  assert.throws(() => saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:1,baseModelHash:'wrong'}),/已变化/);
  assert.equal(prepareResidentialGeneration(sessionId,{baseRevisionId:revisionId,version:1,baseModelHash:saved.baseModelHash}).document.version,1);
});

test('候选不能丢失房间身份、突破面积或修改固定窗洞', (t) => {
  const {model,brief}=setup(t);const document={brief,version:1,baseModelHash:'hash',updatedAt:''};
  const candidate=structuredClone(model);
  candidate.spaces=[{id:'room-main',allocationId:'room-main',usage:'主卧',typeId:'bedroom',enclosed:true,targetArea:14,performancePreferences:{},boundary:[[1,1],[5,1],[5,5],[1,5],[1,1]]}];
  assert.deepEqual(validateResidentialCandidate(candidate,model,document),[]);
  candidate.spaces[0].allocationId='renamed';candidate.spaces[0].id='renamed';
  assert.ok(validateResidentialCandidate(candidate,model,document).some((s) => s.includes('缺少')));
  candidate.openings[1].width+=0.1;
  assert.ok(validateResidentialCandidate(candidate,model,document).some((s) => s.includes('固定构件')));
});

async function generate(body: object) {
  const req=Object.assign(new EventEmitter(),{body}) as Request;
  const events: StreamEvent[]=[];let status=200,result: unknown;
  const res=Object.assign(new EventEmitter(),{writableEnded:false,destroyed:false,setHeader(){},flushHeaders(){},
    status(code:number){status=code;return this;},json(value:unknown){result=value;return this;},
    write(chunk:string){events.push(JSON.parse(chunk));return true;},end(){this.writableEnded=true;return this;}}) as unknown as Response;
  await handleSpaceTurn(req,res,true);return {events,status,result};
}

test('Agent 调用之前已冻结节点图与仿真设置；未保存/错误底图不调用 Agent', async (t) => {
  const {sessionId,revisionId,brief}=setup(t);
  const initial=loadResidentialBrief(sessionId,revisionId).document;
  const saved=saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:0,baseModelHash:initial.baseModelHash});
  let calls=0;
  t.mock.method(echoAdapter,'run',async (input: ChatTurnInput) => {
    calls++;
    assert.match(input.message,/节点图是生成前的需求/);assert.match(input.systemPrompt!,/room-main/);assert.match(input.systemPrompt!,/minAreaRatio/);
    assert.equal(input.nativeSessionId,undefined);
    const folder=path.dirname(input.cwd);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'generation-brief.json'),'utf8')),saved);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'sunlight.json'),'utf8')).targets,[{spaceIds:['room-main'],minHours:2}]);
    return {failed:true};
  });
  const request={sessionId,provider:'echo',mode:'edit',parentRevisionId:revisionId,residentialBrief:{baseRevisionId:revisionId,version:1,baseModelHash:saved.baseModelHash}};
  assert.equal((await generate({...request,residentialBrief:{...request.residentialBrief,version:0}})).status,400);
  assert.equal(calls,0);
  assert.equal((await generate({...request,parentRevisionId:'rev-9999'})).status,400);
  assert.equal(calls,0);
  const response=await generate(request);
  assert.equal(response.status,200);assert.equal(calls,1);
  assert.ok(response.events.some((e) => e.type==='done'&&e.status==='failed'));
});

for(const useScenario of [false,true])test(`节点任务生成候选沿用固定 DXF，外墙外表面轮廓仍可识别入户通行（${useScenario?'场景入口':'兼容入口'}）`, async (t) => {
  const {sessionId,revisionId,brief}=setup(t);
  brief.rooms[0].window='none';
  brief.rooms.push({...room(),id:'room-living',name:'客餐厅',kind:'living',area:{min:20,target:28,max:100},window:'none',sunlight:{...room().sunlight,enabled:false}});
  // This test covers frozen inputs and physical access, independent of the installed Radiance engine.
  for(const r of brief.rooms)r.daylight={enabled:false,minIlluminanceLux:300,minAreaRatio:.5,priority:'soft'};
  brief.relations.push({id:'rel-entry-living',from:entranceNodeId('D1'),to:'room-living',kind:'direct',priority:'hard'});
  const initial=loadResidentialBrief(sessionId,revisionId).document;
  const saved=saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:0,baseModelHash:initial.baseModelHash});
  t.mock.method(echoAdapter,'run',async (input: ChatTurnInput, emit: (e: StreamEvent)=>void) => {
    const folder=path.dirname(input.cwd);
    assert.equal(input.strategyOnly,true);
    emit({type:'text',text:JSON.stringify({schemaVersion:2,rationale:'卧室与入口客餐厅联合分配',roomOrder:['room-main','room-living'],circulation:'auto',preferences:[]})});
    return {failed:false};
  });
  const reference={baseRevisionId:revisionId,version:1,baseModelHash:saved.baseModelHash};
  const response=await generate({sessionId,provider:'echo',mode:'edit',parentRevisionId:revisionId,
    ...(useScenario?{scenario:{id:RESIDENTIAL_SCENARIO.id,version:RESIDENTIAL_SCENARIO.version,input:reference}}:{residentialBrief:reference})});
  const design=response.events.find((e) => e.type==='design');
  assert.ok(design?.type==='design'&&design.valid,JSON.stringify(response.events));
  const candidate=loadDesign(sessionId,'rev-0002')!;
  assert.ok(isAcceptedDesign(sessionId,'rev-0002'));
  assert.ok(candidate.spaces.some(s=>s.allocationId==='room-main'));
  assert.equal(candidate.model.residentialBrief?.status,'pending_simulation');
  const graph=buildSpatialGraph(candidate);
  assert.ok(graph.passable.outside.includes('room-living'));
  assert.ok(reachableFrom(graph,['outside']).has('room-main'));
  const folder=path.join(workspacesDir,sessionId,'designs','rev-0002');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'sunlight.json'),'utf8')).targets,[{spaceIds:['room-main'],minHours:2}]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'scenario.json'),'utf8')),RESIDENTIAL_SCENARIO);
});

test('未知场景、错误场景版本及混用新旧请求在调用 Agent 前拒绝',async t=>{
  const {sessionId,revisionId}=setup(t);let calls=0;
  t.mock.method(echoAdapter,'run',async()=>{calls++;return {failed:true};});
  const request={sessionId,provider:'echo',mode:'edit',parentRevisionId:revisionId};
  for(const scenario of [null,{id:'commercial',version:'1',input:{}},{id:'residential',version:'999',input:{}}]) {
    assert.equal((await generate({...request,scenario})).status,400);
  }
  assert.equal((await generate({...request,scenario:{id:'residential',version:'1',input:{}},residentialBrief:{}})).status,400);
  assert.equal(calls,0);
  assert.equal(fs.existsSync(path.join(workspacesDir,sessionId,'designs','rev-0002')),false);
});

test('同一入户必须直接连接多个房间会提前拒绝，不调用 Agent；逆向关系也检查', async t=> {
  const {sessionId,revisionId,model,brief}=setup(t);
  const second=room();second.id='room-second';second.name='次卧';brief.rooms.push(second);
  brief.relations=[{id:'rel-a',from:'entrance:D1',to:'room-main',kind:'direct',priority:'hard'},
    {id:'rel-b',from:'room-second',to:'entrance:D1',kind:'direct',priority:'hard'}];
  assert.ok(checkResidentialBrief(brief,model).some(i=>i.level==='error'&&i.message.includes('主卧、次卧')));
  const initial=loadResidentialBrief(sessionId,revisionId).document;
  const saved=saveResidentialBrief(sessionId,revisionId,{brief,expectedVersion:0,baseModelHash:initial.baseModelHash});
  let calls=0;t.mock.method(echoAdapter,'run',async ()=>{calls++;return {failed:false};});
  const response=await generate({sessionId,provider:'echo',mode:'edit',parentRevisionId:revisionId,residentialBrief:{baseRevisionId:revisionId,version:saved.version,baseModelHash:saved.baseModelHash}});
  assert.equal(response.status,400);assert.equal(calls,0);
});
