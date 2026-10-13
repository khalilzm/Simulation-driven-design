import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ScenarioWorkspaceInputs, type ResultIdentity, type ResultIdentityContext, type ResidentialBrief } from '@sdd/shared';
import { canonicalHash, createResultIdentity, comparableIdentities, sameCachedResult, semanticRequirements, identityModules, workspaceResultIdentity } from '../src/analysis/runtime/identity';
import { optimizationResultIdentity } from '../src/optimization/resultIdentity';
import { createEvaluationRuntime, type EvaluationRecord } from '../src/analysis/runtime/evaluation';
import { compareCandidate } from '../src/optimization/evaluate';
import { optimizationModel, optimizationSunlight, optimizationPedestrian, evaluation } from './helpers/optimization';
import { createResidentialPreset } from '@sdd/shared';

function setup() {
  const model=optimizationModel();
  const identity=optimizationResultIdentity(model,{sessionId:'test',baseRevisionId:'rev-0001',configs:{sunlight:optimizationSunlight,pedestrian:optimizationPedestrian}});
  return {model,identity};
}

test('canonical hashes ignore object insertion order and reject invalid scientific values',()=>{
  assert.equal(canonicalHash({a:1,b:{y:2,x:3}}),canonicalHash({b:{x:3,y:2},a:1}));
  assert.notEqual(canonicalHash([1,2]),canonicalHash([2,1]));
  assert.throws(()=>canonicalHash({value:NaN}),/非有限/);
  assert.throws(()=>canonicalHash(new Map()),/JSON/);
});

test('cache keys bind actual candidates, comparison keys allow geometry/revision changes',()=>{
  const {model,identity}=setup(),next=structuredClone(model),context=structuredClone(identity.context);
  next.openings[0].width+=.1;context.scope.modelRevisionId='rev-0002';
  const candidate=createResultIdentity(next,context);
  assert.equal(sameCachedResult(candidate,identity),false);
  assert.equal(comparableIdentities(identity,candidate),true);
});

test('input resources, scene, rule, plan, module, conditions and engine versions invalidate reuse/comparison',()=>{
  const {model,identity}=setup();
  const changes:((c:ResultIdentityContext)=>void)[]=[
    c=>c.scope.sessionId='another-session',c=>c.baseMap!.version='rev-9999',
    c=>c.scenario.version='2',c=>c.rules['egress-sunlight-comparison']='next-policy',
    c=>c.plan.version='2',c=>c.modules[0].id='other-module',c=>c.modules[0].version='2',
    c=>c.modules[0].configHash=canonicalHash({newCondition:true}),c=>c.modules[0].engineVersion='next-engine',
    c=>c.requirements={id:'graph',version:'2',contentHash:canonicalHash({rooms:['new']})},
  ];
  for(const change of changes){const context=structuredClone(identity.context);change(context);const next=createResultIdentity(model,context);
    assert.equal(sameCachedResult(next,identity),false);assert.equal(comparableIdentities(identity,next),false);}
  const altered=structuredClone(identity);altered.context.plan.version='corrupt';
  assert.equal(sameCachedResult(altered,identity),false);assert.equal(comparableIdentities(identity,altered),false);
});

test('diagram movement is not a semantic requirement change; actual area edits are',()=>{
  const before=createResidentialPreset('rev-0001'),next:ResidentialBrief=structuredClone(before);
  next.rooms[0].position.x+=10;next.relations[0].diagramHandles={from:'left',to:'right'};
  assert.equal(canonicalHash(semanticRequirements(before)),canonicalHash(semanticRequirements(next)));
  next.rooms[0].area.target+=1;
  assert.notEqual(canonicalHash(semanticRequirements(before)),canonicalHash(semanticRequirements(next)));
});

test('per-module versions and identities survive plan binding',()=>{
  const modules=identityModules({schemaVersion:'1',steps:[
    {moduleId:'a',moduleVersion:'2',capability:'pedestrian',config:optimizationPedestrian},
    {moduleId:'b',moduleVersion:'3',capability:'pedestrian',config:optimizationPedestrian},
  ]},{pedestrian:'engine-v1'});
  assert.deepEqual(modules.map(m=>[m.id,m.version]),[['a','2'],['b','3']]);
});

test('generic workspaces bind independent map, graph and simulation module versions',()=>{
  const workspace:ScenarioWorkspaceInputs={schemaVersion:'1',scenario:{id:'residential',version:'1'},
    baseMap:{id:'map',version:'2',kind:'dxf'},spaceGraph:{id:'graph',version:'3'},simulationModules:[
      {moduleId:'egress-a',version:'4',capability:'pedestrian',config:optimizationPedestrian},
      {moduleId:'egress-b',version:'5',capability:'pedestrian',config:optimizationPedestrian},
    ]};
  const make=(input:ScenarioWorkspaceInputs)=>workspaceResultIdentity(optimizationModel(),'s',input,
    {baseMap:canonicalHash({boundary:[]}),spaceGraph:canonicalHash({rooms:[]})},{pedestrian:'v1'},{routeRules:'1'});
  const original=make(workspace);
  assert.deepEqual(original.context.modules.map(m=>[m.id,m.version]),[['egress-a','4'],['egress-b','5']]);
  const changed=structuredClone(workspace);changed.simulationModules[1].version='6';
  assert.equal(sameCachedResult(original,make(changed)),false);assert.equal(comparableIdentities(original,make(changed)),false);
});

test('legacy identities cannot confirm improvement, and matching geometry alone cannot prove comparability',()=>{
  const a=evaluation(),b=evaluation(18);delete a.identity;delete b.identity;
  assert.equal(compareCandidate(a,b).improved,false);
  const base=evaluation(),candidate=evaluation(18),context=structuredClone(candidate.identity!.context);
  context.rules['egress-sunlight-comparison']='changed';candidate.identity=createResultIdentity(optimizationModel(),context);
  assert.equal(compareCandidate(base,candidate).comparable,false);
});

test('engine evidence cannot claim the declared version when the result reports a different one',()=>{
  const base=evaluation(),candidate=evaluation(18);
  candidate.sunlight.engineVersion='unexpected-engine';
  assert.equal(compareCandidate(base,candidate).comparable,false);
  assert.equal(compareCandidate(base,candidate).improved,false);
});

test('legacy cache remains on disk but is recomputed; forged matching hash without identity is stale',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-identity-cache-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const {identity}=setup(),file=path.join(folder,'result.json');
  type Record=EvaluationRecord<number,number>;
  const runtime=createEvaluationRuntime<{file:string;inputHash:string;identity:ResultIdentity},number,number,Record>({
    inputs:()=>({file,inputHash:identity.inputHash,identity}),
    createRecord:(_input,revisionId)=>({identity,inputHash:identity.inputHash,revisionId,status:'running',startedAt:''}),
    validateResult:()=>{},assess:(_input,result)=>result,messages:{stale:'stale',concurrent:'concurrent',interrupted:'interrupted'},
  });
  const legacy={status:'completed',revisionId:'rev-0001',inputHash:identity.inputHash,result:1,evaluation:1};
  fs.writeFileSync(file,JSON.stringify(legacy));assert.equal(runtime.load('test','rev-0001')?.status,'stale');
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),legacy);
  let calls=0;await runtime.run('test','rev-0001',undefined,async()=>{calls++;return {taskId:'fresh',result:2};});
  const archived=fs.readdirSync(file+'.history');assert.equal(archived.length,1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(file+'.history',archived[0]),'utf8')),legacy);
  await runtime.run('test','rev-0001',undefined,async()=>{calls++;return {taskId:'unexpected',result:3};});
  assert.equal(calls,1);assert.equal(runtime.load('test','rev-0001')?.result,2);
});
