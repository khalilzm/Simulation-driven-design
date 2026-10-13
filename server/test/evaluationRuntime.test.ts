import { EngineTaskExecutionError } from '../src/analysis/runtime/task';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEvaluationRuntime, type EvaluationRecord } from '../src/analysis/runtime/evaluation';

test('evaluation caching, interrupted recovery and target failure remain distinct from execution success',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-runtime-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  let hash='input-v1',calls=0;
  const file=path.join(folder,'evaluation.json');
  const runtime=createEvaluationRuntime<{file:string;inputHash:string},{value:number},{passed:boolean},EvaluationRecord<{value:number},{passed:boolean}>>({
    inputs:()=>({file,inputHash:hash}),
    createRecord:(input,revisionId)=>({status:'running',revisionId,inputHash:input.inputHash,startedAt:new Date().toISOString()}),
    validateResult:result=>{assert.ok(Number.isFinite(result.value));},
    assess:(_input,result)=>({passed:result.value>=10}),
    messages:{stale:'stale',interrupted:'interrupted',concurrent:'concurrent'},
  });
  const analyze=async()=>{calls++;return {taskId:'task',result:{value:5}};};
  const result=await runtime.run('session','rev-1',undefined,analyze);
  assert.equal(result.status,'completed');assert.deepEqual(result.evaluation,{passed:false});
  await runtime.run('session','rev-1',undefined,analyze);assert.equal(calls,1);
  hash='input-v2';assert.equal(runtime.load('session','rev-1')?.status,'stale');
  assert.equal(runtime.load('session','rev-1')?.result,undefined);
  fs.writeFileSync(file,JSON.stringify({...result,status:'running',inputHash:hash}));
  assert.equal(runtime.load('session','rev-1')?.error,'interrupted');
  await runtime.run('session','rev-1',undefined,analyze);assert.equal(calls,2);
});

test('concurrency is scoped to an artifact; cancellation, failure and retry release only its lock',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-runtime-lock-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const runtime=createEvaluationRuntime<{file:string;inputHash:string},number,number,EvaluationRecord<number,number>>({
    inputs:sessionId=>({file:path.join(folder,sessionId+'.json'),inputHash:'v1'}),
    createRecord:(input,revisionId)=>({status:'running',revisionId,inputHash:input.inputHash,startedAt:''}),
    validateResult:()=>{},assess:(_input,result)=>result,
    messages:{stale:'stale',interrupted:'interrupted',concurrent:'concurrent'},
  });
  let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
  const controller=new AbortController();
  const run=runtime.run('a','rev-1',controller.signal,async()=>{await pending;return {taskId:'a',result:1};});
  await assert.rejects(runtime.run('a','rev-1',undefined,async()=>({taskId:'duplicate',result:1})),/concurrent/);
  assert.equal((await runtime.run('b','rev-1',undefined,async()=>({taskId:'b',result:2}))).status,'completed');
  controller.abort();release();assert.equal((await run).status,'cancelled');
  assert.equal(runtime.load('a','rev-1')?.status,'cancelled');
  assert.equal(runtime.load('b','rev-1')?.status,'completed');
  assert.equal((await runtime.run('a','rev-1',undefined,async()=>{throw new Error('engine failed');})).error,'engine failed');
  assert.equal((await runtime.run('a','rev-1',undefined,async()=>({taskId:'retry',result:3}))).status,'completed');
});

test('pre-cancelled evaluation records cancellation without launching an engine',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-runtime-abort-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const runtime=createEvaluationRuntime<{file:string;inputHash:string},number,number,EvaluationRecord<number,number>>({
    inputs:()=>({file:path.join(folder,'result.json'),inputHash:'v1'}),
    createRecord:(input,revisionId)=>({status:'running',revisionId,inputHash:input.inputHash,startedAt:''}),
    validateResult:()=>{},assess:(_input,result)=>result,
    messages:{stale:'stale',interrupted:'interrupted',concurrent:'concurrent'},
  });
  const controller=new AbortController();controller.abort();let calls=0;
  assert.equal((await runtime.run('a','rev-1',controller.signal,async()=>{calls++;return {taskId:'none',result:1};})).status,'cancelled');
  assert.equal(calls,0);
});


test('failed evaluations retain the common engine task reference for diagnostics', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-task-evaluation-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'evaluation.json');
  const runtime = createEvaluationRuntime<{file:string;inputHash:string},number,number,EvaluationRecord<number,number>>({
    inputs: () => ({ file, inputHash: 'input' }),
    createRecord: () => ({ status: 'running', revisionId: 'rev-1', inputHash: 'input', startedAt: '' }),
    assess: (_, result) => result, validateResult: () => {}, messages: { stale: 'stale', concurrent: 'busy', interrupted: 'interrupted' },
  });
  const record = await runtime.run('session', 'rev-1', undefined, async () => {
    throw new EngineTaskExecutionError('recipe failed', 'engine_failed', 'task-identifier', '/tmp/task', 'task-input', 'failed');
  });
  assert.equal(record.status, 'failed'); assert.equal(record.taskId, 'task-identifier');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).taskId, 'task-identifier');
});
