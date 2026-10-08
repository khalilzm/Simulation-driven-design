import type { StreamEvent } from '@sdd/shared';
import type { ChatTurnInput, ProviderAdapter, TurnResult } from '../providers/types';
export class GenerationTimeout extends Error {}
export async function boundedAgent(adapter:ProviderAdapter,input:ChatTurnInput,emit:(e:StreamEvent)=>void,signal:AbortSignal,limits={totalMs:240000,idleMs:90000}):Promise<TurnResult> {
  const controller=new AbortController();let idle:ReturnType<typeof setTimeout>;
  let settled=false;let rejectAbort:(error:Error)=>void=()=>{};
  const failure=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=(error:Error)=>{if(settled)return;controller.abort(error);rejectAbort(error);};
  const parentAbort=()=>abort(signal.reason instanceof Error?signal.reason:new Error('生成已取消'));
  const activity=()=>{if(settled||controller.signal.aborted)return;clearTimeout(idle);idle=setTimeout(()=>abort(new GenerationTimeout(`Agent 连续 ${limits.idleMs/1000} 秒无活动，已停止生成`)),limits.idleMs);};
  const total=setTimeout(()=>abort(new GenerationTimeout(`Agent 单轮超过 ${limits.totalMs/60000} 分钟，已停止生成`)),limits.totalMs);
  signal.addEventListener('abort',parentAbort,{once:true});activity();
  try {
    if(signal.aborted) {parentAbort();await failure;}
    return await Promise.race([adapter.run({...input,onActivity:activity},e=> {
      if(settled||controller.signal.aborted)return;
      if(e.type!=='progress'||!['模型推理中，请稍候…','正在启动 Agent…','正在启动 Cursor Agent…'].includes(e.message)) activity();
      emit(e);
    },controller.signal),failure]);
  } finally {settled=true;clearTimeout(total);clearTimeout(idle!);signal.removeEventListener('abort',parentAbort);}
}
