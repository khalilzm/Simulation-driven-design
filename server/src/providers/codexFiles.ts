import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatTurnInput } from './types';

const MAX_BYTES=4_000_000;
const under=(root:string,file:string)=>file.startsWith(root+path.sep);
const toolSchema={type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false};
export const CODEX_FILE_TOOLS=[
  {type:'function',name:'sdd_read_file',description:'Read a specified JSON input or previously generated JSON file inside the current task workspace.',inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}},
  {type:'function',name:'sdd_write_file',description:'Atomically write a complete valid JSON deliverable inside the current task workspace. Paths are relative to cwd unless absolute.',inputSchema:toolSchema},
];

function jsonPath(cwd:string,value:unknown,write:boolean):string {
  if(typeof value!=='string'||!value||!value.toLowerCase().endsWith('.json'))throw new Error('仅支持任务目录中的JSON文件');
  const root=fs.realpathSync(cwd),file=path.resolve(root,value);
  if(!under(root,file))throw new Error('文件必须位于当前任务目录内');
  let ancestor=write?path.dirname(file):file;
  while(!fs.existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('无法定位文件目录');ancestor=parent;}
  const real=fs.realpathSync(ancestor);
  if(real!==root&&!under(root,real))throw new Error('禁止通过符号链接访问任务目录之外的文件');
  if(fs.existsSync(file)&&!under(root,fs.realpathSync(file)))throw new Error('禁止通过符号链接访问任务目录之外的文件');
  return file;
}

export async function codexFileTool(input:ChatTurnInput,name:unknown,args:unknown,signal?:AbortSignal):Promise<{success:boolean;contentItems:{type:'inputText';text:string}[]}> {
  const result=(success:boolean,text:string)=>({success,contentItems:[{type:'inputText' as const,text}]});
  try {
    if(signal?.aborted)throw new Error('任务已取消');
    if(input.strategyOnly)throw new Error('策略任务只返回JSON文本，不允许读写文件');
    if(name!=='sdd_read_file'&&name!=='sdd_write_file')throw new Error('未知文件工具');
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('文件工具参数无效');
    const parameters=args as {path?:unknown;content?:unknown};
    const file=jsonPath(input.cwd,parameters.path,name==='sdd_write_file');
    if(name==='sdd_read_file') {
      if(input.imagePhase==='extract')throw new Error('首次草图识别只开放写入，输入图已作为原生附件提供');
      if(fs.statSync(file).size>MAX_BYTES)throw new Error('JSON文件过大');
      return result(true,await fs.promises.readFile(file,'utf8'));
    }
    if(typeof parameters.content!=='string'||Buffer.byteLength(parameters.content)>MAX_BYTES)throw new Error('JSON内容无效或过大');
    JSON.parse(parameters.content);
    await fs.promises.mkdir(path.dirname(file),{recursive:true});
    jsonPath(input.cwd,parameters.path,true);
    const tmp=path.join(path.dirname(file),`.sdd-codex-${randomUUID()}.tmp`);
    try {await fs.promises.writeFile(tmp,parameters.content,{flag:'wx'});if(signal?.aborted)throw new Error('任务已取消');await fs.promises.rename(tmp,file);}
    finally {await fs.promises.rm(tmp,{force:true});}
    return result(true,`已保存 ${parameters.path}`);
  }catch(error){return result(false,error instanceof Error?error.message:String(error));}
}
