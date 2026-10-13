import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { StreamEvent } from '@sdd/shared';
import { codexThreadParams, codexTurnInput, createCodexAdapter } from '../src/providers/codex';
import { codexFileTool } from '../src/providers/codexFiles';
import { CodexRpc, type RpcMessage } from '../src/providers/codexRpc';
import { isValidProvider } from '../src/providers/registry';
import { resolveCodexPath } from '../src/config';

class FakeServer extends EventEmitter {
  stdin=new PassThrough();stdout=new PassThrough();stderr=new PassThrough();exitCode:number|null=null;
  calls:RpcMessage[]=[];signals:string[]=[];command='';args:string[]=[];cwd='';private buffer='';
  onRequest:(message:RpcMessage)=>void=()=>{};
  constructor(){super();this.stdin.on('data',chunk=>{
    this.buffer+=chunk.toString();let index:number;
    while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);const message=JSON.parse(line) as RpcMessage;this.calls.push(message);queueMicrotask(()=>this.onRequest(message));}
  });this.stdin.on('finish',()=>this.close());}
  close(code=0){if(this.exitCode!==null)return;this.exitCode=code;this.emit('close',code);}
  kill(signal:string){this.signals.push(signal);this.close();return true;}
  send(message:RpcMessage){this.stdout.write(JSON.stringify(message)+'\n');}
  reply(message:RpcMessage,result:unknown){this.send({id:message.id,result});}
  event(method:string,params:Record<string,unknown>){this.send({method,params:{threadId:'native-thread',...params}});}
  finish(text='{"ok":true}',phase?:string){
    this.event('item/started',{item:{type:'agentMessage',id:'answer',phase}});
    this.event('item/agentMessage/delta',{itemId:'answer',delta:text.slice(0,4)});
    this.event('item/agentMessage/delta',{itemId:'answer',delta:text.slice(4)});
    this.event('item/completed',{item:{type:'agentMessage',id:'answer',text,phase}});
    this.event('turn/completed',{turn:{id:'turn-1',status:'completed'}});
  }
  spawn=(command:string,args:string[],cwd:string)=>{this.command=command;this.args=args;this.cwd=cwd;return this as unknown as ChildProcessWithoutNullStreams;};
  defaults(turn:()=>void=()=>this.finish()){
    this.onRequest=message=>{
      if(message.method==='initialize')this.reply(message,{});
      if(message.method==='account/read')this.reply(message,{account:{type:'chatgpt'},requiresOpenaiAuth:true});
      if(message.method==='thread/start'||message.method==='thread/resume')this.reply(message,{thread:{id:'native-thread'}});
      if(message.method==='turn/start'){this.reply(message,{turn:{id:'turn-1'}});queueMicrotask(turn);}
      if(message.method==='turn/interrupt')this.reply(message,{});
    };
  }
}

async function workspace(t:{after:(fn:()=>Promise<void>)=>void}){const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'sdd-codex-test-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));return cwd;}
const output=(events:StreamEvent[])=>events.filter(e=>e.type==='text').map(e=>e.text).join('');

test('Codex 注册并沿用本机模型，允许显式覆盖，不借用 Cursor 模型',()=>{
  assert.equal(isValidProvider('codex'),true);
  assert.equal('model' in codexThreadParams({cwd:'/tmp',message:'test'},''),false);
  assert.equal(codexThreadParams({cwd:'/tmp',message:'test'},'local-model').model,'local-model');
  assert.equal(codexThreadParams({cwd:'/tmp',message:'test',model:'explicit'},'local-model').model,'explicit');
  const first=codexThreadParams({cwd:'/tmp',message:'test'});
  assert.equal(first.sandbox,'read-only');assert.deepEqual(first.environments,[]);
  assert.equal((first.dynamicTools as {type:string}[])[0].type,'function');
  assert.deepEqual(codexThreadParams({cwd:'/tmp',message:'test',strategyOnly:true}).dynamicTools,[]);
  const resumed=codexThreadParams({cwd:'/tmp',message:'test',nativeSessionId:'native-id'});
  assert.equal(resumed.threadId,'native-id');assert.equal('dynamicTools' in resumed,false);
});

test('CODEX_PATH 支持带空格的可执行文件路径',t=>{
  const previous=process.env.CODEX_PATH;t.after(()=>{if(previous===undefined)delete process.env.CODEX_PATH;else process.env.CODEX_PATH=previous;});
  process.env.CODEX_PATH=' /Applications/My Codex.app/codex ';assert.equal(resolveCodexPath(),'/Applications/My Codex.app/codex');
});

test('Codex 策略只返回最终JSON，过滤 commentary 和内部推理，流式文本不重复',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];
  server.defaults(()=>{
    server.event('item/started',{item:{id:'plan',type:'agentMessage',phase:'commentary'}});
    server.event('item/agentMessage/delta',{itemId:'plan',delta:'planning'});
    server.event('item/completed',{item:{id:'plan',type:'agentMessage',phase:'commentary',text:'planning'}});
    server.event('item/reasoning/textDelta',{delta:'private reasoning'});
    server.finish('{"ok":true}','final_answer');
  });
  const result=await createCodexAdapter({path:'fake codex',spawn:server.spawn}).run({cwd:'/tmp',message:'JSON',strategyOnly:true},e=>events.push(e));
  assert.equal(result.failed,false);assert.equal(result.nativeSessionId,'native-thread');assert.equal(output(events),'{"ok":true}');
  assert.equal(events.some(e=>JSON.stringify(e).includes('planning')||JSON.stringify(e).includes('private reasoning')),false);
  assert.equal(server.command,'fake codex');assert.equal(server.args[0],'app-server');assert.equal(server.exitCode,0);
  for(const key of ['authMs','initializeMs','sendMs','runMs','disposeMs','firstContentMs'] as const)assert.ok(Number.isFinite(result.timings![key]));
});

test('Codex 兼容没有phase的完成消息，并精确恢复原生线程',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];server.defaults();
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'resume',nativeSessionId:'native-thread'},e=>events.push(e));
  assert.equal(result.failed,false);assert.equal(output(events),'{"ok":true}');
  assert.equal(server.calls.some(c=>c.method==='thread/start'),false);
  assert.equal(server.calls.find(c=>c.method==='thread/resume')?.params?.threadId,'native-thread');
});

test('Codex 登录缺失时返回清晰错误，不启动模型任务',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];server.defaults();
  const normal=server.onRequest;server.onRequest=m=>m.method==='account/read'?server.reply(m,{account:null,requiresOpenaiAuth:true}):normal(m);
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'test'},e=>events.push(e));
  assert.equal(result.failed,true);assert.equal(server.calls.some(c=>c.method==='turn/start'),false);
  assert.ok(events.some(e=>e.type==='error'&&e.message.includes('尚未登录')));
});

test('Codex 动态工具实际写入JSON，并把结果回传模型',async t=>{
  const cwd=await workspace(t),server=new FakeServer();server.defaults(()=>server.send({id:'tool-1',method:'item/tool/call',params:{threadId:'native-thread',tool:'sdd_write_file',arguments:{path:'nested/result.json',content:'{"space":"卧室"}'}}}));
  const normal=server.onRequest;server.onRequest=m=>{normal(m);if(m.id==='tool-1'&&!m.method){assert.equal((m.result as {success:boolean}).success,true);server.finish('已保存','final_answer');}};
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd,message:'write'},()=>{});
  assert.equal(result.failed,false);assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd,'nested/result.json'),'utf8')),{space:'卧室'});
  assert.ok(Number.isFinite(result.timings!.afterLastToolMs));
});

test('Codex 静默等待时可取消，调用turn/interrupt并释放进程',async()=>{
  const server=new FakeServer(),controller=new AbortController();server.defaults(()=>setImmediate(()=>controller.abort()));
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'test'},()=>{},controller.signal);
  assert.equal(result.failed,true);assert.equal(server.calls.some(c=>c.method==='turn/interrupt'),true);assert.equal(server.exitCode,0);
});

test('Codex 原生工具审批被拒绝并停止任务',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];server.defaults(()=>server.send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'native-thread',reason:'run shell'}}));
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'test'},e=>events.push(e));
  assert.equal(result.failed,true);assert.deepEqual(server.calls.find(c=>c.id==='approval'&&!c.method)?.result,{decision:'decline'});
  assert.ok(events.some(e=>e.type==='error'&&e.message.includes('未开放')));assert.equal(server.exitCode,0);
});

test('Codex 非正常退出不能冒充成功，即使已有文本输出',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];server.defaults(()=>{
    server.event('item/completed',{item:{id:'partial',type:'agentMessage',text:'partial'}});server.close(1);
  });
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'test'},e=>events.push(e));
  assert.equal(result.failed,true);assert.equal(output(events),'partial');assert.ok(events.some(e=>e.type==='error'&&e.message.includes('已退出')));
});

test('Codex failed turn保留错误，不能作为正常完成',async()=>{
  const server=new FakeServer(),events:StreamEvent[]=[];server.defaults(()=>server.event('turn/completed',{turn:{id:'turn-1',status:'failed',error:{message:'quota exhausted'}}}));
  const result=await createCodexAdapter({spawn:server.spawn}).run({cwd:'/tmp',message:'test'},e=>events.push(e));
  assert.equal(result.failed,true);assert.ok(events.some(e=>e.type==='error'&&e.message==='quota exhausted'));
});

test('Codex 图片以原生data URL传入，拒绝任务目录外的图片',async t=>{
  const cwd=await workspace(t);await fs.writeFile(path.join(cwd,'image.png'),Buffer.from([137,80,78,71]));
  const input={cwd,message:'identify',images:[{path:'image.png',mimeType:'image/png' as const,width:1,height:1}]};
  const items=codexTurnInput(input);assert.equal(items[0].type,'image');assert.equal(items[0].url,'data:image/png;base64,iVBORw==');
  assert.throws(()=>codexTurnInput({...input,images:[{...input.images[0],path:'../outside.png'}]}));
});

test('Codex 文件工具阻止越界、符号链接逃逸、非JSON和无效JSON',async t=>{
  const cwd=await workspace(t),outside=await workspace(t);await fs.symlink(outside,path.join(cwd,'escape'));await fs.writeFile(path.join(outside,'private.json'),'{}');
  await fs.symlink(path.join(outside,'private.json'),path.join(cwd,'linked.json'));
  const input={cwd,message:'test'};
  for(const file of ['../outside.json',path.join(outside,'private.json'),'escape/private.json','linked.json','source.ts']) {
    const result=await codexFileTool(input,'sdd_write_file',{path:file,content:'{}'});assert.equal(result.success,false,file);
  }
  assert.equal((await codexFileTool(input,'sdd_read_file',{path:'linked.json'})).success,false);
  assert.equal((await codexFileTool(input,'sdd_write_file',{path:'bad.json',content:'not json'})).success,false);
  await assert.rejects(fs.access(path.join(cwd,'bad.json')));
  assert.equal(await fs.readFile(path.join(outside,'private.json'),'utf8'),'{}');
});

test('Codex 文件工具限制提取期读取、策略工具和已取消任务',async t=>{
  const cwd=await workspace(t);await fs.writeFile(path.join(cwd,'input.json'),'{}');
  assert.equal((await codexFileTool({cwd,message:'test',imagePhase:'extract'},'sdd_read_file',{path:'input.json'})).success,false);
  assert.equal((await codexFileTool({cwd,message:'test',strategyOnly:true},'sdd_write_file',{path:'out.json',content:'{}'})).success,false);
  assert.equal((await codexFileTool({cwd,message:'test'},'sdd_write_file',{path:'out.json',content:'{}'},AbortSignal.abort())).success,false);
  assert.equal((await codexFileTool({cwd,message:'test',imagePhase:'patch'},'sdd_read_file',{path:'input.json'})).success,true);
});

test('Codex RPC 可解析跨数据块JSONL，正确关联响应并回传RPC错误',async()=>{
  const server=new FakeServer(),rpc=new CodexRpc('fake','/tmp',server.spawn);server.onRequest=m=>{
    const data=JSON.stringify({id:m.id,result:{ok:true}})+'\n';server.stdout.write(data.slice(0,5));server.stdout.write(data.slice(5));
  };
  assert.deepEqual(await rpc.request('initialize',{}),{ok:true});
  server.onRequest=m=>server.send({id:m.id,error:{code:-1,message:'not supported'}});
  await assert.rejects(rpc.request('bad',{}),/not supported/);await rpc.dispose();assert.equal(server.exitCode,0);
});

test('Codex RPC 无效JSON或超时会明确失败并释放请求',async()=>{
  for(const payload of ['not json\n','null\n','[]\n']){
    const server=new FakeServer(),rpc=new CodexRpc('fake','/tmp',server.spawn);let failure='';rpc.onFailure=e=>{failure=e.message;};
    await assert.rejects(rpc.request('no response',{},5),/超时/);
    const request=rpc.request('broken',{});server.stdout.write(payload);
    await assert.rejects(request,/无效JSON/);assert.match(failure,/无效JSON/);await rpc.dispose();assert.equal(server.exitCode,0);
  }
});
