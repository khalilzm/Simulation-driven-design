import { useEffect, useState } from 'react';
import type { ResidentialSolverDiagnostics, SpaceModel } from '@sdd/shared';
import { loadResidentialSolverReport } from '../../api';
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
        {!!Object.keys(report.earlyConnectionPrunes??{}).length&&<details><summary>空间分配阶段的连接检查</summary><p>以下计数是提前淘汰的搜索分支，不代表交付方案存在这些问题。</p><ul>{Object.entries(report.earlyConnectionPrunes!).map(([reason,count])=><li key={reason}>{reason}（{count}次）</li>)}</ul></details>}
        {!!warnings.length&&<><strong>品质与软关系提示</strong><ul>{warnings.map((w,i)=><li key={i}>{w}</li>)}</ul></>}
        {report.quality?.structuralWalls&&<details open><summary>承重墙与空间关系 · 未说明用途的墙段 {report.quality.structuralWalls.unexplainedLength.toFixed(2)}m</summary>
          <table><thead><tr><th>墙体</th><th>空间分界</th><th>两侧同一空间</th><th>保留用途</th></tr></thead><tbody>{report.quality.structuralWalls.walls.map(w=><tr key={w.wallId}><td>{w.wallId}</td><td>{w.separatorLength.toFixed(2)}m</td><td>{w.sameSpaceLength.toFixed(2)}m</td><td>{w.purpose??'未指定'}</td></tr>)}</tbody></table>
          {!!report.quality.publicSpaces?.length&&<table><thead><tr><th>公共空间</th><th>最大完整矩形</th><th>面积占比</th><th>其余面积</th></tr></thead><tbody>{report.quality.publicSpaces.map(s=><tr key={s.spaceId}><td>{s.name}</td><td>{s.coreArea.toFixed(2)}㎡</td><td>{(s.coreRatio*100).toFixed(0)}%</td><td>{s.fragmentationArea.toFixed(2)}㎡</td></tr>)}</tbody></table>}
          {report.quality.wallAlignment&&<p>隔墙短台阶：{report.quality.wallAlignment.steps.length}处，累计错位 {report.quality.wallAlignment.totalOffset.toFixed(2)}m。蓝色线段标记需要连续对齐的位置。</p>}
          {report.quality.structuralConnections&&<><p>承重墙接合：{report.quality.structuralConnections.connections.length}处，续接错位或厚度不一致 {report.quality.structuralConnections.mismatchCount}处。</p>
            <table><thead><tr><th>接合墙体</th><th>方式</th><th>厚度：承重／隔墙</th><th>续接偏移</th></tr></thead><tbody>{report.quality.structuralConnections.connections.map((c,i)=><tr key={i}><td>{c.structuralWallId}／{c.partitionWallId}</td><td>{{continuation:'直线续接',tee:'T接',corner:'转角'}[c.kind]}</td><td>{(c.structuralThickness*1000).toFixed(0)}／{(c.partitionThickness*1000).toFixed(0)}mm</td><td>{(c.axisOffset*1000).toFixed(0)}mm</td></tr>)}</tbody></table></>}
          <p>红色为未说明用途的墙段，橙色为有意保留墙段，绿色为公共空间的最大完整矩形。矩形面积用于比较完整性，不等同于完成家具布置。</p>
          <svg viewBox={`${x0} ${y0} ${x1-x0} ${y1-y0}`} role="img" aria-label="交付方案的承重墙关系与公共空间主体">
            <g transform={`translate(0 ${y0+y1}) scale(1 -1)`}>
              {report.acceptedSpaces?.map(s=><polygon key={s.id} points={s.boundary.map(p=>p.join(',')).join(' ')} fill="#e7e8e2" stroke="#b2b7ac" strokeWidth={(x1-x0)*.002}/>)}
              {report.quality.publicSpaces?.map(s=><polygon key={s.spaceId} points={s.coreBoundary.map(p=>p.join(',')).join(' ')} fill="#c8e8ce" stroke="#4f9360" strokeDasharray={`${(x1-x0)*.012} ${(x1-x0)*.008}`} strokeWidth={(x1-x0)*.003}/>)}
              {base.walls.map(w=><polyline key={w.id} points={w.geometry.points.map(p=>p.join(',')).join(' ')} stroke="#29483f" strokeWidth={w.thickness} fill="none"/>)}
              {report.quality.structuralWalls.walls.flatMap(w=>w.intervals.filter(i=>['same_space','unassigned','intentional'].includes(i.status)).map((i,k)=><polyline key={`${w.wallId}-${k}`} points={i.segment.map(p=>p.join(',')).join(' ')} stroke={i.status==='intentional'?'#ce8a26':'#c64936'} strokeWidth={base.walls.find(b=>b.id===w.wallId)!.thickness*1.4} fill="none"/>))}
              {report.quality.wallAlignment?.steps.map((s,i)=><polyline key={`alignment-${i}`} points={s.segment.map(p=>p.join(',')).join(' ')} stroke="#397da8" strokeWidth={(x1-x0)*.015} fill="none"/>)}
            </g>
          </svg>
        </details>}
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
