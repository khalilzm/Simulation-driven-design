import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createResidentialBrief, type RoomKind, type RoomRequirement } from '@sdd/shared';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';
import { parseResidentialStrategy, type PartitionStrategy } from '../src/design/residentialStrategy';
import { solveResidentialLayout } from '../src/design/residentialSolver';
import { validateAgentModel } from '../src/model/validateAgent';
import { validateModel } from '../src/model/validate';
import { buildSpatialGraph, reachableFrom } from '../src/design/spatialGraph';
const fixture=fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf',import.meta.url),'utf8');
const leaf=(roomId:string):PartitionStrategy=>({roomId});
const split=(axis:'x'|'y',first:PartitionStrategy,second:PartitionStrategy):PartitionStrategy=>({axis,first,second});
const room=(id:string,kind:RoomKind,area:[number,number,number]):RoomRequirement=>({id,name:id,kind,area:{min:area[0],target:area[1],max:area[2]},window:kind==='bedroom'?'required':'preferred',sunlight:{enabled:kind==='bedroom',minHours:2,minAreaRatio:.5,priority:'soft'},position:{x:.1,y:.9}});
function setup() {
  const base=parseFixedEnvelopeDxf(fixture,'fixed.dxf');base.model.revisionId='rev-0001';
  const brief=createResidentialBrief('rev-0001');brief.rooms=[room('room-main','bedroom',[10,14,30])];
  const strategy={schemaVersion:1 as const,rationale:'沿东侧窗布置卧室，公共区接入口',partition:split('x',leaf('solver-circulation'),leaf('room-main')),preferences:[]};
  return {base,brief,strategy};
}
test('策略仅接收分组，拒绝遗漏、重复、坐标与未知窗',()=> {
  const {base,brief,strategy}=setup();
  assert.deepEqual(parseResidentialStrategy(strategy,brief,base),strategy);
  assert.throws(()=>parseResidentialStrategy({...strategy,partition:leaf('solver-circulation')},brief,base),/所有需求/);
  assert.throws(()=>parseResidentialStrategy({...strategy,partition:{...strategy.partition,ratio:.5}},brief,base),/坐标/);
  assert.throws(()=>parseResidentialStrategy({...strategy,preferences:[{roomId:'room-main',windowId:'missing'}]},brief,base),/未知固定窗/);
});
test('求解净空间，保留固定 DXF；节点坐标不改变结果；门连接可供后续图复用',()=> {
  const {base,brief,strategy}=setup();
  const snapshot=JSON.stringify(base);
  const first=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.equal(JSON.stringify(base),snapshot);
  assert.deepEqual(validateAgentModel(first.model).errors,[]);assert.deepEqual(validateModel(first.model).errors,[]);
  for(const key of ['floor','windows','fixedContext'] as const) assert.deepEqual(first.model[key],base[key]);
  assert.ok(first.report.netAvailableArea<108);
  assert.ok(first.model.doors.length>base.doors.length);
  assert.ok(reachableFrom(buildSpatialGraph(first.model),['outside']).has('room-main'));
  brief.rooms[0].position={x:.99,y:.01};
  assert.deepEqual(solveResidentialLayout(base,brief,strategy,'rev-0002').model,first.model);
});
test('硬直接连接与禁止连接冲突不能交付；失败不意味着数学无解',()=> {
  const {base,brief,strategy}=setup();
  brief.relations=[{id:'rel-entry',from:'entrance:D1',to:'room-main',kind:'direct',priority:'hard'}];
  assert.throws(()=>solveResidentialLayout(base,brief,strategy,'rev-0002'),/当前策略未找到可行排布.*入户/);
});
test('住宅两居的多房间策略落地，全部房间具有公共入户路径',()=> {
  const {base,brief}=setup();
  brief.rooms=[room('room-bed1','bedroom',[10,14,22]),room('room-bed2','bedroom',[10,14,22]),room('room-living','living',[20,28,40]),room('room-kitchen','kitchen',[5,7,12]),room('room-bath','bathroom',[3,5,8])];
  brief.relations=[{id:'rel-living-entry',from:'entrance:D1',to:'room-living',kind:'direct',priority:'hard'},
    {id:'rel-living-kitchen',from:'room-living',to:'room-kitchen',kind:'direct',priority:'hard'}];
  const strategy={schemaVersion:1 as const,rationale:'西侧卧室，东北客厅，南侧服务及公共交通',preferences:[],partition:split('x',split('y',leaf('room-bed1'),leaf('room-bed2')),split('y',split('x',leaf('solver-circulation'),split('y',leaf('room-bath'),leaf('room-kitchen'))),leaf('room-living')))};
  const {model}=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.equal(model.spaces.length,6);
  assert.deepEqual(validateAgentModel(model).errors,[]);
  const reached=reachableFrom(buildSpatialGraph(model),['outside']);
  for(const r of brief.rooms) assert.ok(reached.has(r.id));
});

test('Agent 策略失败后收到求解报告，重新分组；禁止直接几何及拒绝残留模型',async t=> {
  const {base,brief}=setup();brief.rooms[0].allowThrough=true;brief.rooms[0].area.max=100;
  const strategy={schemaVersion:2,rationale:'公共入口空间',roomOrder:brief.rooms.map(r=>r.id),circulation:'auto',preferences:[]};
  const {runResidentialTurn}=await import('../src/design/runResidentialTurn');
  const os=await import('node:os');const path=await import('node:path');
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-strategy-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const document={brief,version:1,baseModelHash:'fixture',updatedAt:''};
  const folder=path.join(cwd,'designs','rev-0002');let calls=0;
  const events:import('@sdd/shared').StreamEvent[]=[];
  const adapter:import('../src/providers/types').ProviderAdapter={id:'echo',async run(input,emit) {
    calls++;
    assert.equal(input.strategyOnly,true);
    assert.equal(input.cwd,path.join(folder,'agent'));
    assert.doesNotMatch(input.systemPrompt!,/布局须使用 schemaVersion 3/);
    if(calls===2) assert.match(input.message,/schemaVersion/);
    emit({type:'text',text:JSON.stringify(calls===1?{}:strategy)});
    return {failed:false};
  }};
  const result=await runResidentialTurn({cwd,revisionId:'rev-0002',residentialBrief:document,base},adapter,e=>events.push(e));
  assert.equal(result.failed,false);assert.equal(calls,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'generation-brief.json'),'utf8')),document);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'solver-report.json'),'utf8')).status,'solved');
  assert.ok(events.some(e=>e.type==='design'&&e.valid));
});

test('六房间策略含交通区偏好可求解；入口、窗和硬关系在候选筛选前保留',()=> {
  const {base,brief}=setup();
  brief.rooms=[room('room-main','bedroom',[10,14,22]),room('room-living','living',[20,28,40]),room('room-second','bedroom',[10,14,22]),room('room-bathroom','bathroom',[3,5,8]),room('room-kitchen','kitchen',[5,7,12]),room('room-study','study',[5,9,18])];
  brief.relations=brief.rooms.map((r,i)=>({id:`rel-entry-${i}`,from:'entrance:D1',to:r.id,kind:r.kind==='living'?'direct' as const:'public_access' as const,priority:'hard' as const}));
  brief.relations.push({id:'rel-living-kitchen',from:'room-living',to:'room-kitchen',kind:'direct',priority:'hard'},
    {id:'rel-kitchen-main',from:'room-kitchen',to:'room-main',kind:'no_direct',priority:'hard'},
    {id:'rel-kitchen-second',from:'room-kitchen',to:'room-second',kind:'no_direct',priority:'hard'});
  const strategy=parseResidentialStrategy({schemaVersion:1,rationale:'南部卧室与厨房、北部服务及公共交通，以固定门窗检验切分',
    partition:{...split('x',split('y',split('x',split('y',leaf('room-main'),leaf('room-study')),leaf('solver-circulation')),leaf('room-bathroom')),split('y',split('x',leaf('room-second'),leaf('room-kitchen')),leaf('room-living'))),alignWallId:'S11'},
    preferences:[{roomId:'room-main',side:'south',windowId:'W1'},{roomId:'room-second',side:'south',windowId:'W2'},{roomId:'room-kitchen',side:'south',windowId:'W3'},
      {roomId:'room-living',side:'north',windowId:'W5'},{roomId:'room-bathroom',side:'north',windowId:'W4'},{roomId:'room-study',side:'north',windowId:'W4'},{roomId:'solver-circulation',side:'north'}]},brief,base);
  const {model,report}=solveResidentialLayout(base,brief,strategy,'rev-0002');
  assert.equal(model.spaces.length,7);
  assert.deepEqual(validateAgentModel(model).errors,[]);assert.deepEqual(validateModel(model).errors,[]);
  assert.equal(report.checks.length,brief.relations.length);
  const graph=buildSpatialGraph(model);
  for(const r of brief.rooms)assert.ok(reachableFrom(graph,['outside']).has(r.id));
  for(const opening of base.openings)assert.ok(graph.edges.some(e=>e.openingId===opening.id),`固定洞口 ${opening.id} 必须完整关联空间`);
  assert.ok(report.combinationChecks>0);
  assert.deepEqual(report.quality.errors,[]);
  assert.ok(model.doors.filter(d=>d.id!=='D1').every(d=>d.swing!=='none'&&d.opensTo));
});

test('拒绝的切分保存几何与原因，不能通过改变入口目标刷过校验',async()=> {
  const {base,brief,strategy}=setup();
  brief.relations=[{id:'rel-entry',from:'entrance:D1',to:'room-main',kind:'direct',priority:'hard'}];
  const {ResidentialSolveError}=await import('../src/design/residentialSolver');
  assert.throws(()=>solveResidentialLayout(base,brief,strategy,'rev-0002'),(error:unknown)=> {
    assert.ok(error instanceof ResidentialSolveError);
    const regions=error.report.rejectedRegions as {geometry:unknown;reason:string}[];
    assert.ok(regions.length>0);assert.ok(regions.every(r=>r.geometry&&r.reason));
    assert.ok(String(error).includes('入户'));return true;
  });
});
