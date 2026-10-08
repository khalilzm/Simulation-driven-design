import { test } from 'node:test';
import assert from 'node:assert/strict';
// Load the browser module at runtime without applying Node's fetch types to its source.
const { generate } = await import('../../web/src/' + 'api.ts') as { generate: (session: string, provider: string, onEvent: (e: {type: string})=>void, parent?: undefined, task?: undefined, signal?: AbortSignal)=>Promise<void> };

test('流提前关闭不会被当作完成，HTTP 冲突原因会传给界面',async t=> {
  t.mock.method(globalThis,'fetch',async()=>new Response('{"type":"progress","message":"生成中"}\n',{status:200}));
  await assert.rejects(generate('session','echo',()=>{}),/完成前中断/);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'同一入户不能直接进入多个房间'}),{status:400}));
  await assert.rejects(generate('session','echo',()=>{}),/同一入户/);
});
test('完成事件正常收尾，取消信号传入 fetch',async t=> {
  const controller=new AbortController();let seen=false;
  t.mock.method(globalThis,'fetch',async(_url: Parameters<typeof fetch>[0],init?: Parameters<typeof fetch>[1])=>{assert.equal(init?.signal,controller.signal);return new Response('{"type":"done","status":"completed"}\n');});
  await generate('session','echo',e=>{if(e.type==='done')seen=true;},undefined,undefined,controller.signal);
  assert.equal(seen,true);
});
