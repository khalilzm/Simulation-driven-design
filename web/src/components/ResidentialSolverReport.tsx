import { useEffect, useState } from 'react';
import type { ResidentialSolverDiagnostics, SpaceModel } from '@sdd/shared';
import { loadResidentialSolverReport } from '../api';
import './ResidentialSolverReport.css';

export function ResidentialSolverReport({sessionId,revisionId,base}:{sessionId:string;revisionId:string;base:SpaceModel}) {
  const [report,setReport]=useState<ResidentialSolverDiagnostics>(),[open,setOpen]=useState(false),[index,setIndex]=useState(0),[error,setError]=useState('');
  useEffect(()=>{let active=true;setReport(undefined);setError('');setIndex(0);loadResidentialSolverReport(sessionId,revisionId).then(r=>{if(active)setReport(r);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[sessionId,revisionId]);
  const points=base.floor.boundary,x0=Math.min(...points.map(p=>p[0])),x1=Math.max(...points.map(p=>p[0])),y0=Math.min(...points.map(p=>p[1])),y1=Math.max(...points.map(p=>p[1]));
  const candidate=report?.rejectedCandidates?.[index],warnings=[...new Set([...(report?.warnings??[]),...(report?.quality?.warnings??[])])];
  return <div className="residential-solver-report">
    <button onClick={()=>setOpen(!open)} aria-expanded={open}>求解报告 · {revisionId} {report?.status==='solved'?'· 已找到候选':report?'· 未交付候选':''}</button>
    {open&&<div className="residential-solver-report-body">
      {!report?<p>{error||'正在读取报告…'}</p>:<>
        {report.failureType&&<p>失败阶段：{({strategy_format:'策略格式校验',model_validation:'完整模型验证',no_room_candidate:'单房间候选分配',unsupported_geometry:'底图几何支持范围',unsupported_program:'需求支持范围',time_budget:'求解时间预算',grid_budget:'网格规模预算',search_exhausted:'布局组合搜索'} as Record<string,string>)[report.failureType]??report.failureType}</p>}
        <p>{report.method==='obstacle-grid-allocation'?'障碍网格分配':report.method??'策略校验'}{report.gridSize?` · 网格 ${report.gridSize}m`:''}{report.searchVisits!==undefined?` · 搜索 ${report.searchVisits} 次`:''}{report.searchLimitReached?' · 搜索达到预算':''}。搜索失败不代表需求无解。</p>
        {report.errors?.map((e,i)=><p key={`e-${i}`} className="solver-error">{e}</p>)}
        {!!report.failures?.length&&<ul>{report.failures.map((f,i)=><li key={i}>{f.reason}（{f.count}次）</li>)}</ul>}
        {!!warnings.length&&<><strong>品质与软关系提示</strong><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></>}
        {candidate&&<>
          <label>查看被拒绝的候选 <select value={index} onChange={e=>setIndex(Number(e.target.value))}>{report.rejectedCandidates!.map((_,i)=><option key={i} value={i}>候选 {i+1}</option>)}</select></label>
          <p>以下仅用于定位冲突，未通过验证，不能作为生成方案使用。</p>
          <svg viewBox={`${x0} ${y0} ${x1-x0} ${y1-y0}`} role="img" aria-label="被拒绝候选与固定承重墙的位置示意">
            <g transform={`translate(0 ${y0+y1}) scale(1 -1)`}>
              {candidate.spaces.map(s=><polygon key={s.id} points={s.boundary.map(p=>p.join(',')).join(' ')} fill="#f2c9b8" stroke="#a46349" strokeWidth={(x1-x0)*.002}/>)}
              {base.walls.map(w=><polyline key={w.id} points={w.geometry.points.map(p=>p.join(',')).join(' ')} stroke="#29483f" strokeWidth={w.thickness} fill="none"/>)}
            </g>
            {candidate.spaces.map(s=>{const ps=s.boundary.slice(0,-1),cx=ps.reduce((n,p)=>n+p[0],0)/ps.length,cy=ps.reduce((n,p)=>n+p[1],0)/ps.length;return <text key={s.id} x={cx} y={y0+y1-cy} textAnchor="middle" fontSize={(x1-x0)*.025}>{s.usage}</text>;})}
          </svg>
          <ul>{candidate.errors.map((e,i)=><li key={i}>{e}</li>)}</ul>
        </>}
      </>}
    </div>}
  </div>;
}
