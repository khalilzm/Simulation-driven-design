import type { ResidentialDaylightRecord } from '@sdd/shared';
export function ResidentialEvaluationPanel({record,busy,running,onRun,onFocus,onCancel}:{record:ResidentialDaylightRecord|null|undefined;busy:boolean;running:boolean;onCancel?:()=>void;onRun:()=>void;onFocus:(id:string)=>void}) {
  const evaluation=record?.evaluation;
  const label=running||record?.status==='running'?'正在计算室内采光…':record?.status==='completed'?evaluation?.status==='passed'?`已完成目标评价${evaluation.softUnmetCount?` · ${evaluation.softUnmetCount}个软目标未满足`:''}`:evaluation?.status==='failed'?'硬采光目标未满足':evaluation?.status==='not_configured'?'未设置房间采光目标':'部分房间无法评价':record?.status==='stale'?'评价已过期':record?.status==='failed'?'采光计算失败':record?.status==='cancelled'?'采光计算已取消':'尚未进行采光评价';
  return <div className="residential-solver-report">
    <strong>{label}</strong> <button disabled={busy} onClick={onRun}>{record?.status==='completed'?'查看采光热力图':'运行采光评价'}</button>
    {busy&&onCancel&&<button onClick={onCancel}>取消当前任务</button>}
    {record?.error&&<p className="solver-error">{record.error}。几何候选已保留。</p>}
    {record?.result?.sampling?.status==='needs_review'&&<p className="solver-error">部分采样结果尚未稳定，不能据此确认达标或完全没有采光。</p>}
    {evaluation&&<details><summary>房间目标与实际结果 · 需求版本 {record!.briefVersion}</summary>
      <table><thead><tr><th>房间</th><th>目标</th><th>平均／最大照度</th><th>平均采光系数</th><th>实际达标面积比例</th><th>评价覆盖率</th><th>采样精度</th><th>结果</th></tr></thead><tbody>{evaluation.rooms.map(r=><tr key={r.roomId}><td><button onClick={()=>onFocus(r.roomId)}>{r.name}</button></td><td>{r.enabled?`${r.minIlluminanceLux} lx／${Math.round(r.requiredRatio*100)}%`:'未设置'}</td><td>{r.meanLux===null?'—':`${r.meanLux.toFixed(0)} lx／${(r.maxLux??0).toFixed(0)} lx`}</td><td>{r.meanDaylightFactor===null?'—':`${r.meanDaylightFactor.toFixed(2)}%`}</td><td>{r.actualRatio===null?'—':`${(r.actualRatio*100).toFixed(1)}%`}</td><td>{(r.coverageRatio*100).toFixed(1)}%</td><td>{r.samplingStatus==='converged'?'两级结果稳定':'待确认'}</td><td>{r.status==='passed'?'满足':r.status==='failed'?`${r.priority==='hard'?'硬':'软'}目标未满足`:r.status==='needs_review'?r.reason:'未设置'}</td></tr>)}</tbody></table>
      {evaluation.assumptions.map((s,i)=><p key={i}>{s}</p>)}
    </details>}
  </div>;
}
