import fs from 'node:fs';
import path from 'node:path';
export interface GenerationState {
  status: 'running'|'completed'|'failed'|'cancelled'|'interrupted'|'timed_out';
  phase: string; startedAt: string; updatedAt: string; ownerPid: number;
  attempt: number; errors?: string[]; timings: { attempt:number;agentMs:number;solverMs:number;validationMs:number;tools:number }[];
}
const active = new Map<string,{controller:AbortController;state:GenerationState}>();
export function persistGeneration(folder:string,state:GenerationState) {
  state.updatedAt=new Date().toISOString();
  fs.writeFileSync(path.join(folder,'generation-state.json.tmp'),JSON.stringify(state,null,2));
  fs.renameSync(path.join(folder,'generation-state.json.tmp'),path.join(folder,'generation-state.json'));
}
export function registerGeneration(folder:string,controller:AbortController,state:GenerationState) {
  active.set(folder,{controller,state});persistGeneration(folder,state);return ()=>active.delete(folder);
}
function interrupted(folder:string,state?:GenerationState) {
  const errors=['服务重启导致生成中断，请重新提交；已保留节点需求与策略报告'];
  if(state) persistGeneration(folder,{...state,status:'interrupted',phase:'interrupted',errors});
  fs.writeFileSync(path.join(folder,'validation.json'),JSON.stringify({valid:false,status:'interrupted',errors},null,2));
}
export function interruptActiveGenerations() {
  for(const [folder,{controller,state}] of active) {
    state.status='interrupted';state.phase='interrupted';interrupted(folder,state);controller.abort(new Error('服务重启导致生成中断'));
  }
}
export function recoverInterruptedGenerations(root:string):number {
  if(!fs.existsSync(root)) return 0;
  let count=0;
  for(const session of fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.'))) {
    const designs=path.join(root,session.name,'designs');if(!fs.existsSync(designs)) continue;
    for(const revision of fs.readdirSync(designs,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^rev-\d+$/.test(e.name))) {
      const folder=path.join(designs,revision.name);
      if (active.has(folder)) continue;
      try {
        if(!fs.existsSync(path.join(folder,'generation-brief.json'))) continue;
        const statePath=path.join(folder,'generation-state.json');
        const state:GenerationState|undefined=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):undefined;
        const validation=JSON.parse(fs.readFileSync(path.join(folder,'validation.json'),'utf8'));
        if(state?.status!=='running'&&validation.status!=='pending') continue;
        if(state?.ownerPid && state.ownerPid!==process.pid) {
          try {process.kill(state.ownerPid,0);continue;} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') continue;}
        }
        interrupted(folder,state);count++;
      }catch { /* Ignore unrelated or malformed revisions. */ }
    }
  }
  return count;
}
