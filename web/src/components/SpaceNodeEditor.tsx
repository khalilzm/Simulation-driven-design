import { useEffect, useRef, useState } from 'react';
import { checkResidentialBrief, createResidentialPreset, layoutSettings, permitsThrough, entranceNodeId, RELATION_LABELS, ROOM_LABELS,
  type ResidentialBrief, type ResidentialBriefDocument, type RoomKind, type RoomRelation,
  type RoomRequirement, type SpaceModel } from '@sdd/shared';
import { loadResidentialBrief, saveResidentialBrief } from '../api';
import './SpaceNodeEditor.css';

const COLORS: Record<RoomKind, string> = { living: '#7b998b', bedroom: '#7d90b4', kitchen: '#bc9569', bathroom: '#759da8', study: '#9d86ad', circulation: '#92988d', other: '#9a9187' };
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function newRoom(kind: RoomKind, index: number): RoomRequirement {
  const area = kind === 'living' ? [20,28,40] : kind === 'bedroom' ? [10,14,22] : kind === 'kitchen' ? [5,7,12] : kind === 'bathroom' ? [3,5,8] : [5,9,18];
  return { id: uid('room'), name: `${ROOM_LABELS[kind]}${index + 1}`, kind,
    area: { min: area[0], target: area[1], max: area[2] }, window: kind === 'bedroom' ? 'required' : 'preferred',
    sunlight: { enabled: false, minHours: 2, minAreaRatio: 0.5, priority: 'soft' },
    position: { x: 0.35 + (index % 3)*0.25, y: 0.22 + (Math.floor(index/3)%4)*0.2 } };
}

export function SpaceNodeEditor({ sessionId, model, busy, onGenerate, onCancel }: {
  sessionId: string; model: SpaceModel; busy: boolean; onGenerate: (document: ResidentialBriefDocument) => Promise<void>;
  onCancel?: () => void;
}) {
  const [document, setDocument] = useState<ResidentialBriefDocument>();
  const [brief, setBrief] = useState<ResidentialBrief>();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<'node' | 'sunlight' | 'layout'>('node');
  const [kind, setKind] = useState<RoomKind>('bedroom');
  const [localBusy, setLocalBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [beforePreset, setBeforePreset] = useState<ResidentialBrief>();
  const [edge, setEdge] = useState<RoomRelation>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; y: number; ox: number; oy: number }>();
  const disabled = busy || localBusy;
  useEffect(() => {
    let cancelled = false;
    setDocument(undefined); setBrief(undefined); setNotice('加载空间需求…');
    loadResidentialBrief(sessionId, model.model.revisionId).then((value) => {
      if (cancelled) return;
      setDocument(value); setBrief(value.brief); setDirty(false); setSelected(value.brief.rooms[0]?.id); setEdge(undefined);
      setBeforePreset(undefined);
      setNotice(value.version ? `已加载需求版本 ${value.version}` : '已预填两居一卫住宅需求，可直接编辑后保存。日照工况为上海示例，请按项目修改。');
    }).catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [sessionId, model.model.revisionId, loadAttempt]);

  const update = (next: ResidentialBrief) => { setBrief(next); setDirty(true); };
  if (!brief || !document) return <div className="space-editor-loading"><p role="status">{notice}</p><button onClick={() => setLoadAttempt((n) => n+1)}>重新加载</button></div>;
  const room = brief.rooms.find((r) => r.id === selected);
  const anchors = model.doors.map((d,i) => ({ id: entranceNodeId(d.id), name: `入户口 ${d.id}`, x: 0.11, y: Math.min(0.85,0.4+i*0.18) }));
  const nodes = [...anchors, ...brief.rooms.map((r) => ({ id: r.id, name: r.name, x: r.position.x, y: r.position.y }))];
  const issues = checkResidentialBrief(brief, model);
  const errors = issues.filter((i) => i.level === 'error');
  const patchRoom = (patch: Partial<RoomRequirement>) => {
    if (room) update({ ...brief, rooms: brief.rooms.map((r) => r.id === room.id ? { ...r, ...patch } : r) });
  };
  const patchSun = (patch: Partial<ResidentialBrief['sunlight']>) => update({ ...brief, sunlight: { ...brief.sunlight, ...patch } });
  const addRoom = () => {
    const r = newRoom(kind, brief.rooms.length);
    r.name = `${ROOM_LABELS[kind]}${brief.rooms.filter((r) => r.kind === kind).length+1}`;
    update({ ...brief, rooms: [...brief.rooms,r] }); setSelected(r.id); setEdge(undefined); setTab('node');
  };
  const example = () => {
    const preset = createResidentialPreset(brief.baseRevisionId, model.doors[0]?.id);
    setBeforePreset(brief);
    update({ ...brief, rooms: preset.rooms, relations: preset.relations }); setSelected('room-main'); setEdge(undefined); setTab('node');
    setNotice('已应用两居一卫住宅预设，可编辑或撤销；保存后生效。');
  };
  const save = async () => {
    setLocalBusy(true);
    try {
      const saved = await saveResidentialBrief(sessionId,document,brief);
      setDocument(saved); setDirty(false); setNotice(`需求版本 ${saved.version} 已保存`);
      return saved;
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { setLocalBusy(false); }
  };
  const submit = async () => {
    if (errors.length) { setNotice('请先处理检查中的错误'); return; }
    const saved = await save();
    if (saved) await onGenerate(saved);
  };
  const startEdge = () => { setEdge({ id: uid('rel'), from: selected ?? nodes[0]?.id ?? '', to: nodes.find((n) => n.id !== selected)?.id ?? '', kind:'direct',priority:'hard' }); setTab('node'); };
  const applyEdge = () => {
    if (!edge || !edge.from || !edge.to || edge.from===edge.to) { setNotice('请选择两个不同节点'); return; }
    update({ ...brief, relations: [...brief.relations.filter((e) => e.id !== edge.id),edge] }); setNotice('关系已更新，尚未保存');
  };

  return <section className="space-editor" aria-label="生成前空间节点图">
    <header className="space-editor-header">
      <div><h2>空间节点图</h2><p>定义空间与日照要求，再交给 Agent 生成。节点位置只表示关系图排版。</p></div>
      <div className="space-editor-actions">
        <button disabled={disabled} onClick={() => void save()}>保存需求{dirty ? ' · 未保存' : ''}</button>
        <button className="space-primary" disabled={disabled || errors.length>0} onClick={() => void submit()}>制定策略并生成平面</button>
        {onCancel && <button onClick={onCancel}>取消生成</button>}
      </div>
    </header>
    <div className="space-editor-body">
      <div className="space-graph-column">
        <div className="space-graph-tools">
          <select aria-label="新增房间类型" value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value as RoomKind)}>{Object.entries(ROOM_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select>
          <button disabled={disabled || brief.rooms.length>=32} onClick={addRoom}>添加房间</button>
          <button disabled={disabled || nodes.length<2} onClick={startEdge}>添加关系</button>
          <button disabled={disabled} onClick={example}>应用住宅预设 · 两居一卫</button>
          {beforePreset && <button disabled={disabled} onClick={() => { update(beforePreset); setSelected(beforePreset.rooms[0]?.id); setEdge(undefined); setBeforePreset(undefined); setNotice('已撤销预设，尚未保存'); }}>撤销预设</button>}
        </div>
        <div className="space-graph-scroll">
          <div className="space-graph-stage" ref={stage} onPointerMove={(event) => {
            const d = drag.current;
            if (!d || !stage.current || disabled) return;
            const bounds = stage.current.getBoundingClientRect();
            const position = { x: Math.max(0.12,Math.min(0.87,d.ox+(event.clientX-d.x)/bounds.width)), y:Math.max(0.12,Math.min(0.88,d.oy+(event.clientY-d.y)/bounds.height)) };
            update({ ...brief, rooms: brief.rooms.map((r) => r.id===d.id ? {...r,position} : r) });
          }} onPointerUp={() => { drag.current=undefined; }} onPointerCancel={() => { drag.current=undefined; }}>
            <svg className="space-graph-edges" viewBox="0 0 1000 700" preserveAspectRatio="none" aria-hidden="true">
              {brief.relations.map((e) => { const a=nodes.find((n) => n.id===e.from), b=nodes.find((n) => n.id===e.to); if (!a||!b) return null;
                return <line key={e.id} x1={a.x*1000} y1={a.y*700} x2={b.x*1000} y2={b.y*700} className={`space-edge space-edge--${e.kind}${edge?.id===e.id ? ' selected' : ''}`} strokeDasharray={e.priority==='soft' ? '8 6' : undefined} />; })}
            </svg>
            {brief.relations.map((e,index) => { const a=nodes.find((n) => n.id===e.from), b=nodes.find((n) => n.id===e.to); if (!a||!b) return null;
              return <button className={`space-edge-label${edge?.id===e.id ? ' selected' : ''}`} key={e.id} disabled={disabled}
                style={{left:`${(a.x+b.x)*50}%`,top:`calc(${(a.y+b.y)*50}% + ${(index%3-1)*14}px)`}}
                aria-label={`${a.name}与${b.name}：${RELATION_LABELS[e.kind]}，${e.priority==='hard'?'必须':'尽量'}`}
                onClick={() => { setEdge(e);setTab('node'); }}>{RELATION_LABELS[e.kind]}</button>; })}
            {nodes.map((n) => { const r=brief.rooms.find((r) => r.id===n.id); return <button key={n.id}
              className={`space-node${!r?' space-node--anchor':''}${selected===n.id?' selected':''}`}
              style={{left:`${n.x*100}%`,top:`${n.y*100}%`,borderTopColor:r?COLORS[r.kind]:'#c99451'}} disabled={disabled}
              aria-pressed={selected===n.id} onClick={() => {setSelected(n.id);setEdge(undefined);setTab('node');}}
              onPointerDown={(event) => {
                if (!r || disabled || event.button!==0) return;
                drag.current={id:r.id,x:event.clientX,y:event.clientY,ox:r.position.x,oy:r.position.y};
                event.currentTarget.setPointerCapture(event.pointerId); setSelected(n.id); setEdge(undefined);
              }}>
              <strong>{n.name || '未命名空间'}</strong>
              {r ? <><span>{r.area.min}～{r.area.max} ㎡</span><span>{r.sunlight.enabled?`日照 ≥ ${r.sunlight.minHours} h · ${Math.round(r.sunlight.minAreaRatio*100)}%`:'未设置日照目标'}</span></> : <span>固定底图接口</span>}
            </button>; })}
            {!brief.rooms.length && <div className="space-graph-empty">添加房间节点，开始定义住宅需求</div>}
          </div>
        </div>
        <div className="space-graph-key"><span>实线：必须满足</span><span>虚线：尽量满足</span><span>点击节点或连线编辑 · 房间节点可拖动</span></div>
        <details className="space-checks" open={errors.length>0}><summary>生成前检查 · {errors.length} 个错误 · {issues.filter((i) => i.level==='warning').length} 个提示</summary>
          <ul>{issues.map((issue,i) => <li key={i} className={issue.level==='error'?'space-error':''}><button onClick={() => {if(issue.nodeId){setSelected(issue.nodeId);setTab('node');setEdge(undefined);}}}>{issue.message}</button></li>)}</ul>
          {!issues.length && <p>需求可以提交。几何可行性和性能达标情况需要在生成后验证。</p>}
        </details>
        <p className="space-editor-notice" role="status">{notice}</p>
      </div>
      <aside className="space-inspector">
        <div className="space-inspector-tabs"><button className={tab==='node'?'active':''} onClick={() => setTab('node')}>节点与关系</button><button className={tab==='layout'?'active':''} onClick={() => setTab('layout')}>布局参数</button><button className={tab==='sunlight'?'active':''} onClick={() => setTab('sunlight')}>全局日照工况</button></div>
        <fieldset disabled={disabled}>
          {tab==='layout' ? <>
            <legend>布局使用要求</legend><p className="space-muted">网格用于初步分配，最终计算墙厚与精确净边界。以下是可编辑的设计参数，不代表规范认证；房间形状和尾部通常作为品质提示。</p>
            {(['gridSize','passageWidth','doorWidth','doorDepth'] as const).map((key,i)=><label key={key}>{['布局网格尺寸','通行净宽','新增门宽','门前净空深度'][i]}（m）<input type="number" min={key==='gridSize'?.2:.6} max={key==='gridSize'?1:key==='doorWidth'?1.5:2} step="0.1" value={layoutSettings(brief)[key]} onChange={e=>update({...brief,layout:{...layoutSettings(brief),[key]:Number(e.target.value)}})}/></label>)}
            <p className="space-muted">独立走廊按需生成；客餐厅可以承担通行。默认不对房间强加家具主体尺寸，可在各房间节点设置。</p>
          </> : tab==='sunlight' ? <>
            <legend>全局日照工况</legend><p className="space-muted">所有房间及候选共用。预填值是上海冬至示例，请核对地点、日期和北向。</p>
            <div className="space-fields"><label>纬度<input type="number" step="any" value={brief.sunlight.location.latitude} onChange={(e) => patchSun({location:{...brief.sunlight.location,latitude:Number(e.target.value)}})} /></label><label>经度<input type="number" step="any" value={brief.sunlight.location.longitude} onChange={(e) => patchSun({location:{...brief.sunlight.location,longitude:Number(e.target.value)}})} /></label></div>
            <label>时区<input value={brief.sunlight.location.timezone} onChange={(e) => patchSun({location:{...brief.sunlight.location,timezone:e.target.value}})} /></label>
            <label>分析日期<input type="date" value={brief.sunlight.analysisDate} onChange={(e) => patchSun({analysisDate:e.target.value})} /></label>
            <div className="space-fields"><label>开始时间<input type="time" value={brief.sunlight.localTimeRange[0]} onChange={(e) => patchSun({localTimeRange:[e.target.value,brief.sunlight.localTimeRange[1]]})} /></label><label>结束时间<input type="time" value={brief.sunlight.localTimeRange[1]} onChange={(e) => patchSun({localTimeRange:[brief.sunlight.localTimeRange[0],e.target.value]})} /></label></div>
            <label>真北角度（°）<input type="number" step="any" value={brief.sunlight.northDegrees} onChange={(e) => patchSun({northDegrees:Number(e.target.value)})} /></label><p className="space-muted">模型 +Y 轴逆时针转至真北的角度。</p>
            <div className="space-fields"><label>测点间距（m）<input type="number" min="0.1" step="0.1" value={brief.sunlight.sensors.gridSpacing} onChange={(e) => patchSun({sensors:{...brief.sunlight.sensors,gridSpacing:Number(e.target.value)}})} /></label><label>测点高度（m）<input type="number" min="0" step="0.05" value={brief.sunlight.sensors.referenceHeightAboveFloor} onChange={(e) => patchSun({sensors:{...brief.sunlight.sensors,referenceHeightAboveFloor:Number(e.target.value)}})} /></label></div>
            <label>时间步长（分钟）<input type="number" min="1" max="120" value={brief.sunlight.timestepMinutes} onChange={(e) => patchSun({timestepMinutes:Number(e.target.value)})} /></label>
          </> : edge ? <>
            <legend>{brief.relations.some((e) => e.id===edge.id)?'编辑关系':'添加关系'}</legend>
            <label>起点<select value={edge.from} onChange={(e) => setEdge({...edge,from:e.target.value})}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
            <label>终点<select value={edge.to} onChange={(e) => setEdge({...edge,to:e.target.value})}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
            <label>关系<select value={edge.kind} onChange={(e) => setEdge({...edge,kind:e.target.value as RoomRelation['kind']})}>{Object.entries(RELATION_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <p className="space-muted">{edge.kind==='direct'?'必须通过门或开放通道直接连接。':edge.kind==='adjacent'?'共享边界，不要求开门。':edge.kind==='public_access'?'从起点可经允许穿行的房间或交通空间到达终点。':'可以相邻，但不能直接开门或形成开放通道。'}</p>
            <label>优先级<select value={edge.priority} onChange={(e) => setEdge({...edge,priority:e.target.value as RoomRelation['priority']})}><option value="hard">必须满足</option><option value="soft">尽量满足</option></select></label>
            <button className="space-primary" onClick={applyEdge}>应用关系</button>
            {brief.relations.some((e) => e.id===edge.id) && <button className="space-danger" onClick={() => {update({...brief,relations:brief.relations.filter((e) => e.id!==edge.id)});setEdge(undefined);}}>删除关系</button>}
          </> : room ? <>
            <legend>{room.name || '房间需求'}</legend>
            <label>房间名称<input value={room.name} maxLength={60} onChange={(e) => patchRoom({name:e.target.value})} /></label>
            <label>空间类型<select value={room.kind} onChange={(e) => patchRoom({kind:e.target.value as RoomKind})}>{Object.entries(ROOM_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <div className="space-fields space-fields--three">{(['min','target','max'] as const).map((key,i) => <label key={key}>{['最小','期望','最大'][i]}净面积（㎡）<input type="number" min="0.1" step="0.5" value={room.area[key]} onChange={(e) => patchRoom({area:{...room.area,[key]:Number(e.target.value)}})} /></label>)}</div>
            <label className="space-checkbox"><input type="checkbox" checked={permitsThrough(room)} onChange={e=>patchRoom({allowThrough:e.target.checked})}/>允许作为其他房间的穿行路径</label>
            <label className="space-checkbox"><input type="checkbox" checked={!!room.bodySize} onChange={e=>patchRoom({bodySize:e.target.checked?[2,2]:undefined})}/>指定可容纳的主体尺寸</label>
            {room.bodySize&&<div className="space-fields">{([0,1] as const).map(i=><label key={i}>主体{['宽','深'][i]}（m）<input type="number" min="0.5" max="20" step="0.1" value={room.bodySize![i]} onChange={e=>{const body:[number,number]=[...room.bodySize!];body[i]=Number(e.target.value);patchRoom({bodySize:body});}}/></label>)}</div>}
            <label>外窗需求<select value={room.window} onChange={(e) => patchRoom({window:e.target.value as RoomRequirement['window']})}><option value="required">必须有外窗</option><option value="preferred">尽量有外窗</option><option value="none">无要求</option></select></label>
            <hr/><h3>房间日照目标</h3>
            <label className="space-checkbox"><input type="checkbox" checked={room.sunlight.enabled} onChange={(e) => patchRoom({sunlight:{...room.sunlight,enabled:e.target.checked}})} />参与日照目标评价</label>
            {room.sunlight.enabled && <><label>直射日照时长 ≥（h）<input type="number" min="0" max="24" step="0.5" value={room.sunlight.minHours} onChange={(e) => patchRoom({sunlight:{...room.sunlight,minHours:Number(e.target.value)}})} /></label>
              <label>达标面积比例 ≥（%）<input type="number" min="1" max="100" value={Math.round(room.sunlight.minAreaRatio*100)} onChange={(e) => patchRoom({sunlight:{...room.sunlight,minAreaRatio:Number(e.target.value)/100}})} /></label>
              <label>目标优先级<select value={room.sunlight.priority} onChange={(e) => patchRoom({sunlight:{...room.sunlight,priority:e.target.value as 'hard'|'soft'}})}><option value="hard">必须满足</option><option value="soft">尽量满足</option></select></label></>}
            <p className="space-muted">当前为生成前目标，暂无仿真结果。地点、日期和测点规则在全局面板设置。</p>
            <button onClick={() => setTab('sunlight')}>设置全局日照工况</button>
            <hr/><button onClick={startEdge}>为此房间添加关系</button>
            <button className="space-danger" onClick={() => {update({...brief,rooms:brief.rooms.filter((r) => r.id!==room.id),relations:brief.relations.filter((e) => e.from!==room.id&&e.to!==room.id)});setSelected(undefined);}}>删除房间及相关关系</button>
          </> : <><legend>{anchors.find((a) => a.id===selected)?.name ?? '选择节点'}</legend><p>点击房间设置需求，点击连线编辑关系。入户口来自固定底图，可以建立通行联系。</p><button disabled={nodes.length<2} onClick={startEdge}>添加关系</button></>}
        </fieldset>
        <label className="space-notes">补充设计要求<textarea disabled={disabled} value={brief.notes} maxLength={4000} rows={3} onChange={(e) => update({...brief,notes:e.target.value})} placeholder="例如主卧安静、避免穿越卧室…" /></label>
      </aside>
    </div>
  </section>;
}
