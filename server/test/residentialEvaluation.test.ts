import { sunlightEngineId } from '../src/config';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createResidentialBrief,evaluateResidentialSunlight,type SunlightResult,type ResidentialBriefDocument} from '@sdd/shared';
import {sampleModel} from './fixtures/sampleModel';
import {workspacesDir} from '../src/config';
import {loadResidentialEvaluation,runResidentialEvaluation} from '../src/scenarios/residential/residentialDirectSunEvaluation';
function setup(){
 const model=structuredClone(sampleModel),room=model.spaces[0];room.id='room-main';room.allocationId='room-main';room.boundary=[[0,0],[2,0],[2,2],[0,2],[0,0]];
 const brief=createResidentialBrief('rev-0001');brief.rooms=[{id:'room-main',name:'主卧',kind:'bedroom',area:{min:3,target:4,max:10},window:'none',sunlight:{enabled:true,minHours:2,minAreaRatio:.5,priority:'hard'},position:{x:.5,y:.5}}];
 const result:SunlightResult={schemaVersion:'1',status:'completed',engineVersion:sunlightEngineId,metrics:{unit:'hour',sensorCount:2,targetAreaRatio:.5},spaces:[{spaceId:'room-main',sensorCount:2,sampledArea:4,meanHours:1,minHours:0,maxHours:2,targetMetRatio:.5}],sampling:{method:'test',status:'converged',baseFineStep:.1,refinedFineStep:.05,rooms:[{allocationId:'room-main',status:'converged',baseTargetRatio:.5,refinedTargetRatio:.5,meanHoursDelta:0,targetRatioDelta:0}]},verification:{status:'failed',checks:['旧规则全部测点未满足']}};
 return {model,brief,result};
}
test('住宅目标按面积比例通过，不能沿用全部测点通过状态；硬软目标独立评价',()=>{
 const {model,brief,result}=setup();const evaluation=evaluateResidentialSunlight(model,brief,1,result);
 assert.equal(evaluation.status,'passed');assert.equal(evaluation.rooms[0].status,'passed');assert.equal(evaluation.rooms[0].actualRatio,.5);
 brief.rooms[0].sunlight.minAreaRatio=.6;let next=evaluateResidentialSunlight(model,brief,1,result);assert.equal(next.status,'failed');assert.equal(next.hardUnmetCount,1);assert.ok(Math.abs(next.rooms[0].ratioGap!-.1)<1e-8);
 brief.rooms[0].sunlight.priority='soft';next=evaluateResidentialSunlight(model,brief,1,result);assert.equal(next.hardUnmetCount,0);assert.equal(next.softUnmetCount,1);
});
test('缺失测点、失败、覆盖不足不能当成零日照或通过；无目标明确标记',()=>{
 const {model,brief,result}=setup();for(const value of [{...result,spaces:[]},{...result,status:'failed' as const},{...result,spaces:[{...result.spaces[0],sampledArea:2}]}]){const e=evaluateResidentialSunlight(model,brief,1,value);assert.equal(e.status,'needs_review');assert.equal(e.rooms[0].actualRatio,null);}
 brief.rooms[0].sunlight.enabled=false;assert.equal(evaluateResidentialSunlight(model,brief,1,result).status,'not_configured');
});
test('住宅评价冻结需求、可恢复与缓存；改变模型后结果过期；异常保留几何候选',async t=>{
 const {model,brief,result}=setup();model.model.residentialBrief={baseRevisionId:'rev-0001',version:1,status:'pending_simulation'};
 const sessionId=`test-residential-eval-${randomUUID()}`,revisionId=model.model.revisionId;
 const folder=path.join(workspacesDir,sessionId,'designs',revisionId);fs.mkdirSync(folder,{recursive:true});t.after(()=>fs.rmSync(path.join(workspacesDir,sessionId),{recursive:true,force:true}));
 const write=(name:string,value:unknown)=>fs.writeFileSync(path.join(folder,name),JSON.stringify(value));
 const doc:ResidentialBriefDocument={brief,version:1,baseModelHash:'test',updatedAt:''};write('model.json',model);write('validation.json',{valid:true});write('generation-brief.json',doc);
 let calls=0;const analyze:Parameters<typeof runResidentialEvaluation>[3]=async input=>{calls++;assert.equal((input.configRaw as any).targets[0].minHours,2);return {taskId:'test',inputHash:'test',result,simulationDir:'test'};};
 const first=await runResidentialEvaluation(sessionId,revisionId,undefined,analyze);assert.equal(first.status,'completed');assert.equal(first.evaluation?.rooms[0].status,'passed');assert.deepEqual(loadResidentialEvaluation(sessionId,revisionId),first);
 await runResidentialEvaluation(sessionId,revisionId,undefined,analyze);assert.equal(calls,1);
 brief.rooms[0].sunlight.minAreaRatio=.8;write('generation-brief.json',doc);assert.equal(loadResidentialEvaluation(sessionId,revisionId)?.status,'stale');
 const failed=await runResidentialEvaluation(sessionId,revisionId,undefined,async()=>{throw new Error('引擎故障');});assert.equal(failed.status,'failed');assert.ok(fs.existsSync(path.join(folder,'model.json')));
});

test('同一候选拒绝并发，取消可落盘并重新评价，几何输入保持不变',async t=>{
 const {model,brief,result}=setup();model.model.residentialBrief={baseRevisionId:'rev-0001',version:1,status:'pending_simulation'};
 const sessionId=`test-residential-cancel-${randomUUID()}`,revisionId=model.model.revisionId,folder=path.join(workspacesDir,sessionId,'designs',revisionId);
 fs.mkdirSync(folder,{recursive:true});t.after(()=>fs.rmSync(path.join(workspacesDir,sessionId),{recursive:true,force:true}));
 for(const [file,value] of Object.entries({'model.json':model,'validation.json':{valid:true},'generation-brief.json':{brief,version:1,baseModelHash:'test',updatedAt:''}}))fs.writeFileSync(path.join(folder,file),JSON.stringify(value));
 const before=fs.readFileSync(path.join(folder,'model.json'),'utf8');
 let started!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const controller=new AbortController();
 const analyze:Parameters<typeof runResidentialEvaluation>[3]=async input=>{assert.equal(input.signal,controller.signal);started();await gate;return {taskId:'test',inputHash:'test',result,simulationDir:'test'};};
 const first=runResidentialEvaluation(sessionId,revisionId,controller.signal,analyze);await entered;
 assert.equal(loadResidentialEvaluation(sessionId,revisionId)?.status,'running');
 await assert.rejects(runResidentialEvaluation(sessionId,revisionId,undefined,analyze),/正在进行/);
 controller.abort();release();assert.equal((await first).status,'cancelled');assert.equal(loadResidentialEvaluation(sessionId,revisionId)?.status,'cancelled');
 assert.equal(fs.readFileSync(path.join(folder,'model.json'),'utf8'),before);
 const retry=await runResidentialEvaluation(sessionId,revisionId,undefined,async()=>({taskId:'retry',inputHash:'test',result,simulationDir:'test'}));assert.equal(retry.status,'completed');
});

test('采样未收敛或两级结果跨过面积目标时不能确认达标，缺少精度信息也不能通过',()=>{
 const {model,brief,result}=setup();
 const missing={...result,sampling:undefined};assert.equal(evaluateResidentialSunlight(model,brief,1,missing).rooms[0].status,'needs_review');
 result.sampling!.rooms[0].status='needs_review';assert.equal(evaluateResidentialSunlight(model,brief,1,result).rooms[0].status,'needs_review');
 result.sampling!.rooms[0]={allocationId:'room-main',status:'converged',baseTargetRatio:.499,refinedTargetRatio:.501};result.spaces[0].targetMetRatio=.501;
 const evaluated=evaluateResidentialSunlight(model,brief,1,result);assert.equal(evaluated.rooms[0].status,'needs_review');assert.match(evaluated.rooms[0].reason!,/跨越/);
});
