import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequestScope } from '../../web/src/workbench/requestScope';

test('late evaluation cannot overwrite another session with the same revision, even after returning',async()=>{
  const scope=createRequestScope();const displayed:string[]=[];
  let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
  scope.setContext(JSON.stringify(['session-a','rev-1']));const old=scope.begin('evaluation');
  const response=delayed.then(()=>{if(scope.isCurrent(old))displayed.push('old-a');});
  scope.setContext(JSON.stringify(['session-b','rev-1']));
  const current=scope.begin('evaluation');if(scope.isCurrent(current))displayed.push('b');
  scope.setContext(JSON.stringify(['session-a','rev-1']));
  release();await response;assert.deepEqual(displayed,['b']);
});

test('superseded loads, newer runs and unmount cleanup do not commit stale responses',async()=>{
  const scope=createRequestScope();scope.setContext('selection');const committed:string[]=[];
  let release!:()=>void;const delayed=new Promise<void>(resolve=>{release=resolve;});
  const load=scope.begin('load');const result=delayed.then(()=>{if(scope.isCurrent(load))committed.push('cached');});
  scope.invalidate('load');const run=scope.begin('run');if(scope.isCurrent(run))committed.push('new result');
  release();await result;assert.deepEqual(committed,['new result']);
  const first=scope.begin('save'),second=scope.begin('save');
  assert.equal(scope.isCurrent(first),false);assert.equal(scope.isCurrent(second),true);
  scope.invalidateAll();assert.equal(scope.isCurrent(second),false);assert.equal(scope.isCurrent(run),false);
});
