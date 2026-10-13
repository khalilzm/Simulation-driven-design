import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface RpcMessage {id?:number|string;method?:string;params?:Record<string,unknown>;result?:unknown;error?:{code?:number;message?:string}}
export type CodexSpawn = (command:string,args:string[],cwd:string)=>ChildProcessWithoutNullStreams;
const defaultSpawn:CodexSpawn=(command,args,cwd)=>spawn(command,args,{cwd,shell:false,stdio:['pipe','pipe','pipe']});

/** One isolated stdio connection per provider run; no credential files or tokens are read here. */
export class CodexRpc {
  private child:ChildProcessWithoutNullStreams;
  private sequence=0;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private buffer='';
  private stderr='';
  private stopped=false;
  private disposed=false;
  private disposal:Promise<void>|undefined;
  private closed:Promise<void>;
  onMessage:(message:RpcMessage)=>void=()=>{};
  onFailure:(error:Error)=>void=()=>{};

  constructor(command:string,cwd:string,spawnProcess:CodexSpawn=defaultSpawn) {
    this.child=spawnProcess(command,['app-server','--listen','stdio://','-c','mcp_servers={}'],cwd);
    this.closed=new Promise(resolve=>{
      this.child.once('close',code=>{
        if(!this.disposed)this.fail(new Error(`Codex app-server 已退出（${code??'signal'}）${this.stderr.trim()?`：${this.stderr.trim().split('\n').slice(-2).join('\n')}`:''}`));
        this.stopped=true;this.rejectPending(new Error('Codex app-server 连接已关闭'));resolve();
      });
    });
    this.child.once('error',error=>{this.fail(error);});
    this.child.stdin.on('error',error=>{if(!this.disposed)this.fail(error);});
    this.child.stderr.setEncoding('utf8');this.child.stderr.on('data',(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-2000);});
    this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;
      if(this.buffer.length>16_000_000){this.fail(new Error('Codex 单条事件超出大小限制'));void this.dispose();return;}
      let index:number;
      while((index=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);
        if(!line.trim())continue;
        let message:RpcMessage;
        try {
          const parsed:unknown=JSON.parse(line);
          if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid RPC message');
          message=parsed as RpcMessage;
        }catch{this.fail(new Error('Codex app-server 返回无效JSON事件'));void this.dispose();return;}
        if(message.id!==undefined&&!message.method) {
          const pending=typeof message.id==='number'?this.pending.get(message.id):undefined;
          if(pending){clearTimeout(pending.timer);this.pending.delete(message.id as number);message.error?pending.reject(new Error(message.error.message??'Codex RPC失败')):pending.resolve(message.result);}
        } else this.onMessage(message);
      }
    });
  }

  private rejectPending(error:Error):void {for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  private fail(error:Error):void {if(this.stopped||this.disposed)return;this.stopped=true;this.rejectPending(error);this.onFailure(error);}
  send(message:RpcMessage):void {if(this.stopped||this.disposed)throw new Error('Codex连接已关闭');this.child.stdin.write(JSON.stringify(message)+'\n');}
  notify(method:string,params:Record<string,unknown>={}):void {this.send({method,params});}
  respond(id:number|string,result:unknown):void {this.send({id,result});}
  respondError(id:number|string,message:string):void {this.send({id,error:{code:-32601,message}});}
  request(method:string,params:Record<string,unknown>,timeoutMs=30000):Promise<unknown> {
    return new Promise((resolve,reject)=>{
      const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex ${method} 请求超时`));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try {this.send({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  dispose():Promise<void> {
    return this.disposal??=(this.closeProcess());
  }
  private async closeProcess():Promise<void> {
    this.disposed=true;this.rejectPending(new Error('Codex连接已关闭'));
    if(this.child.exitCode!==null)return;
    this.child.stdin.end();
    const term=setTimeout(()=>{this.child.kill('SIGTERM');},500);
    const kill=setTimeout(()=>{this.child.kill('SIGKILL');},2500);
    let end:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([this.closed,new Promise<void>(resolve=>{end=setTimeout(resolve,3000);})]);}
    finally {clearTimeout(term);clearTimeout(kill);clearTimeout(end);}
  }
}
