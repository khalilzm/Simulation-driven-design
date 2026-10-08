import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundedAgent, GenerationTimeout } from '../src/generation/boundedAgent';
import { recoverInterruptedGenerations, persistGeneration, type GenerationState } from '../src/generation/lifecycle';
import { buildCursorAgentOptions } from '../src/providers/cursor';
import { buildCommand } from '../src/providers/claude';
import type { ProviderAdapter } from '../src/providers/types';

test('策略任务在 Cursor 和 Claude 都禁用文件及其他工具',()=> {
  assert.deepEqual(buildCursorAgentOptions('composer-2.5','/tmp',undefined,undefined,true).tools,[]);
  const command=buildCommand({cwd:'/tmp',message:'json',strategyOnly:true});
  assert.equal(command.args[command.args.indexOf('--tools')+1],'');
});
test('无活动超时会中止 provider，忽略迟到输出及虚假心跳',async ()=> {
  let aborted=false;
  const adapter:ProviderAdapter={id:'echo',run(_input,emit,signal) {
    signal?.addEventListener('abort',()=>{aborted=true;});
    const timer=setInterval(()=>emit({type:'progress',message:'模型推理中，请稍候…'}),5);
    signal?.addEventListener('abort',()=>clearInterval(timer));
    return new Promise(()=>{});
  }};
  await assert.rejects(boundedAgent(adapter,{cwd:'/tmp',message:'json'},()=>{},new AbortController().signal,{totalMs:100,idleMs:20}),GenerationTimeout);
  assert.equal(aborted,true);
});
test('总时限即使持续有事件也生效；主动取消不等待 provider 返回',async ()=> {
  const adapter:ProviderAdapter={id:'echo',run(input,_emit,signal) {
    const timer=setInterval(()=>input.onActivity?.(),5);signal?.addEventListener('abort',()=>clearInterval(timer));
    return new Promise(()=>{});
  }};
  await assert.rejects(boundedAgent(adapter,{cwd:'/tmp',message:'json'},()=>{},new AbortController().signal,{totalMs:30,idleMs:100}),/单轮超过/);
  const controller=new AbortController();const task=boundedAgent(adapter,{cwd:'/tmp',message:'json'},()=>{},controller.signal);
  controller.abort(new Error('用户取消'));await assert.rejects(task,/用户取消/);
});
test('重启恢复遗留 pending，仅修改任务状态并保留策略及冻结需求',t=> {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const folder=path.join(root,'session','designs','rev-0001');fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'generation-brief.json'),'{}');fs.writeFileSync(path.join(folder,'strategy.json'),'original');
  fs.writeFileSync(path.join(folder,'validation.json'),JSON.stringify({valid:false,status:'pending'}));
  assert.equal(recoverInterruptedGenerations(root),1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'validation.json'),'utf8')).status,'interrupted');
  assert.equal(fs.readFileSync(path.join(folder,'strategy.json'),'utf8'),'original');
  assert.equal(recoverInterruptedGenerations(root),0);
});
