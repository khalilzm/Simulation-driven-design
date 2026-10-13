import { DAYLIGHT_ENGINE_ID } from '../src/daylight/run';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createResidentialBrief,briefDaylightConfig,roomDaylight,evaluateResidentialDaylight,type DaylightResult,type ResidentialBriefDocument} from '@sdd/shared';
import {sampleModel} from './fixtures/sampleModel';
import {workspacesDir} from '../src/config';
import {loadResidentialEvaluation,runResidentialEvaluation} from '../src/scenarios/residential/residentialEvaluation';
function setup(){
 const model=structuredClone(sampleModel);model.spaces=[{...model.spaces[0],id:'room-main',allocationId:'room-main',boundary:[[0,0],[2,0],[2,2],[0,2],[0,0]]}];
 const brief=createResidentialBrief('rev-0001');brief.rooms=[{id:'room-main',name:'主卧',kind:'bedroom',area:{min:3,target:4,max:10},window:'none',sunlight:{enabled:true,minHours:8,minAreaRatio:.5,priority:'hard'},daylight:{enabled:true,minIlluminanceLux:300,minAreaRatio:.5,priority:'hard'},position:{x:.5,y:.5}}];
 const result:DaylightResult={schemaVersion:'1',status:'completed',engineVersion:DAYLIGHT_ENGINE_ID,method:'overcast-daylight-factor',outdoorIlluminanceLux:10000,spaces:[{spaceId:'room-main',allocationId:'room-main',sensorCount:2,sampledArea:4,meanLux:300,minLux:100,maxLux:500,meanDaylightFactor:3,targetMetRatio:.5}],grids:[],sampling:{status:'converged',baseSpacing:.5,refinedSpacing:.25,rooms:[{allocationId:'room-main',status:'converged',meanLuxDelta:0,targetRatioDelta:0,baseTargetRatio:.5,refinedTargetRatio:.5}]},assumptions:[]};
 return {model,brief,result};
}
test('采光以面积比例判定，硬软目标独立；旧小时数不转换为照度',()=>{
 const {model,brief,result}=setup();assert.equal(evaluateResidentialDaylight(model,brief,1,result).status,'passed');
 brief.rooms[0].daylight!.minAreaRatio=.6;assert.equal(evaluateResidentialDaylight(model,brief,1,result).hardUnmetCount,1);
 brief.rooms[0].daylight!.priority='soft';assert.equal(evaluateResidentialDaylight(model,brief,1,result).softUnmetCount,1);
 delete brief.rooms[0].daylight;assert.equal(roomDaylight(brief.rooms[0]).minIlluminanceLux,300);assert.equal(briefDaylightConfig(brief).targets[0].minIlluminanceLux,300);
});
test('覆盖不足、未收敛、非有限结果、缺失测点不能被当成达标或零采光',()=>{
 const {model,brief,result}=setup();for(const mutate of [(r:DaylightResult)=>r.spaces[0].sampledArea=2,(r:DaylightResult)=>r.sampling!.rooms[0].status='needs_review',(r:DaylightResult)=>r.spaces[0].meanLux=NaN,(r:DaylightResult)=>r.spaces=[]]){const r=structuredClone(result);mutate(r);const e=evaluateResidentialDaylight(model,brief,1,r);assert.equal(e.status,'needs_review');assert.equal(e.rooms[0].actualRatio,null);}
 brief.rooms[0].daylight!.enabled=false;assert.equal(evaluateResidentialDaylight(model,brief,1,result).status,'not_configured');
});
test('采光评价独立缓存、冻结需求变化后过期，失败不改几何与旧日照记录',async t=>{
 const {model,brief,result}=setup();model.model.residentialBrief={baseRevisionId:'rev-0001',version:1,status:'pending_simulation'};
 const sid=`test-daylight-${randomUUID()}`,rev=model.model.revisionId,folder=path.join(workspacesDir,sid,'designs',rev);fs.mkdirSync(folder,{recursive:true});t.after(()=>fs.rmSync(path.join(workspacesDir,sid),{recursive:true,force:true}));
 const write=(n:string,v:unknown)=>fs.writeFileSync(path.join(folder,n),JSON.stringify(v));const doc:ResidentialBriefDocument={brief,version:1,baseModelHash:'test',updatedAt:''};write('model.json',model);write('validation.json',{valid:true});write('generation-brief.json',doc);write('residential-evaluation.json',{legacy:true});
 let calls=0;const analyze:Parameters<typeof runResidentialEvaluation>[3]=async input=>{calls++;assert.equal(input.config.targets[0].minIlluminanceLux,300);return {taskId:'test',inputHash:'test-hash',result,simulationDir:'test'};};
 assert.equal((await runResidentialEvaluation(sid,rev,undefined,analyze)).evaluation?.status,'passed');await runResidentialEvaluation(sid,rev,undefined,analyze);assert.equal(calls,1);
 brief.daylight!.materials.windowTransmittance=.4;write('generation-brief.json',doc);assert.equal(loadResidentialEvaluation(sid,rev)?.status,'stale');
 assert.equal((await runResidentialEvaluation(sid,rev,undefined,async()=>{throw new Error('test');})).status,'failed');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'model.json'),'utf8')),model);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'residential-evaluation.json'),'utf8')),{legacy:true});
});
