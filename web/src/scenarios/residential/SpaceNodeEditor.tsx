import { SpaceGraphCanvas } from './SpaceGraphCanvas';
import type { Connection } from '@xyflow/react';
import { useEffect, useState } from 'react';
import { checkResidentialBrief, createResidentialPreset, layoutSettings, permitsThrough, RELATION_LABELS, ROOM_LABELS,
  type ResidentialBrief, type ResidentialBriefDocument, type RoomKind, type RoomRelation,
  createResidentialBrief, parseResidentialBrief, residentialBriefChanges, nextResidentialBriefDocument, type RoomRequirement, type SpaceModel } from '@sdd/shared';
import { loadResidentialBrief, saveResidentialBrief } from '../../api';
import './SpaceNodeEditor.css';

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export function newRoom(kind: RoomKind, index: number): RoomRequirement {
  const area = kind === 'living' ? [20,28,40] : kind === 'bedroom' ? [10,14,22] : kind === 'kitchen' ? [5,7,12] : kind === 'bathroom' ? [3,5,8] : kind === 'balcony' ? [2,4,8] : [5,9,18];
  return { id: uid('room'), name: `${ROOM_LABELS[kind]}${index + 1}`, kind,
    area: { min: area[0], target: area[1], max: area[2] }, window: kind === 'bedroom' ? 'required' : 'preferred',
    sunlight: { enabled: false, minHours: 2, minAreaRatio: 0.5, priority: 'soft' },
    position: { x: 0.35 + (index % 3)*0.25, y: 0.22 + (Math.floor(index/3)%4)*0.2 } };
}

export function SpaceNodeEditor({ sessionId, model, busy, onSelectRoom, selectedRoomId, onBriefChange }: {
  sessionId: string; model?: SpaceModel; busy: boolean;
  selectedRoomId?:string;onSelectRoom?:(id:string)=>void;
  onBriefChange?: (brief: ResidentialBrief, version: number, dirty: boolean, layout?: { graphLayoutVersion: number; layoutDirty: boolean }) => void;
}) {
  const [document, setDocument] = useState<ResidentialBriefDocument>();
  const [brief, setBrief] = useState<ResidentialBrief>();
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<'node' | 'layout'>('node');
  const [kind, setKind] = useState<RoomKind>('bedroom');
  const [localBusy, setLocalBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [beforePreset, setBeforePreset] = useState<ResidentialBrief>();
  const [edge, setEdge] = useState<RoomRelation>();
  useEffect(()=>{if(selectedRoomId){setSelected(selectedRoomId);setEdge(undefined);setTab('node');}},[selectedRoomId]);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const disabled = busy || localBusy;
  useEffect(() => {
    let cancelled = false;
    setDocument(undefined); setBrief(undefined); setNotice('加载空间需求…');
    if (!model) {
      const key = `sdd.residentialBriefDraft:${sessionId}`;
      let saved: ResidentialBriefDocument | undefined;
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const candidate = JSON.parse(raw) as ResidentialBriefDocument;
          saved = { ...candidate, brief: parseResidentialBrief(candidate.brief) };
        }
      } catch { /* Ignore an invalid or unavailable local draft. */ }
      const value = saved ? { ...saved, brief: { ...saved.brief, relations: saved.brief.relations.filter(relation => !relation.from.startsWith('entrance:') && !relation.to.startsWith('entrance:')) } }
        : { brief: createResidentialBrief('rev-1'), baseModelHash: '', version: 0, updatedAt: '' };
      const removedDxfLinks = !!saved && value.brief.relations.length !== saved.brief.relations.length;
      setDocument(value); setBrief(value.brief);
      setDirty(removedDxfLinks); setSelected(value.brief.rooms[0]?.id); setEdge(undefined); setBeforePreset(undefined);
      setNotice(saved ? '已恢复本地空间节点草稿；可继续编辑房间和连接关系。' : '可先编辑空间节点图；当前草稿保存在本地。方案通过 Agent 对话生成。');
      return () => { cancelled = true; };
    }
    loadResidentialBrief(sessionId, model.model.revisionId).then((loaded) => {
      if (cancelled) return;
      const value = { ...loaded, brief: { ...loaded.brief, relations: loaded.brief.relations.filter(relation => !relation.from.startsWith('entrance:') && !relation.to.startsWith('entrance:')) } };
      const removedDxfLinks = value.brief.relations.length !== loaded.brief.relations.length;
      setDocument(value); setBrief(value.brief); setDirty(removedDxfLinks); setSelected(value.brief.rooms[0]?.id); setEdge(undefined);
      setBeforePreset(undefined);
      setNotice(value.version ? `已加载需求版本 ${value.version}；仿真目标请在独立的仿真指标模块中配置。` : '已预填两居一卫住宅需求，可直接编辑后保存；方案请通过 Agent 对话生成。');
    }).catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [sessionId, model?.model.revisionId, loadAttempt]);

  const update = (next: ResidentialBrief) => { setBrief(next); setDirty(document ? residentialBriefChanges(document.brief, next).semantic : true); };
  const layoutDirty = !!brief && !!document && residentialBriefChanges(document.brief, brief).layout;
  const anchors: { id: string; name: string; x: number; y: number }[] = [];
  useEffect(() => { if (brief && document) onBriefChange?.(brief, document.version, dirty, { graphLayoutVersion: document.graphLayoutVersion ?? 0, layoutDirty }); }, [brief, document, dirty, layoutDirty, onBriefChange]);
  if (!brief || !document) return <div className="space-editor-loading"><p role="status">{notice}</p><button onClick={() => setLoadAttempt((n) => n+1)}>重新加载</button></div>;
  const room = brief.rooms.find((r) => r.id === selected);

  const nodes = brief.rooms.map((r) => ({ id: r.id, name: r.name, x: r.position.x, y: r.position.y }));
  const issues = model ? checkResidentialBrief(brief, model) : [];
  const errors = issues.filter((i) => i.level === 'error');
  const patchRoom = (patch: Partial<RoomRequirement>) => {
    if (room) update({ ...brief, rooms: brief.rooms.map((r) => r.id === room.id ? { ...r, ...patch } : r) });
  };
  const addRoom = () => {
    const r = newRoom(kind, brief.rooms.length);
    r.name = `${ROOM_LABELS[kind]}${brief.rooms.filter((r) => r.kind === kind).length+1}`;
    update({ ...brief, rooms: [...brief.rooms,r] }); setSelected(r.id); setEdge(undefined); setTab('node');
  };
  const example = () => {
    const preset = createResidentialPreset(brief.baseRevisionId);
    setBeforePreset(brief);
    update({ ...brief, rooms: preset.rooms, relations: preset.relations }); setSelected('room-main'); setEdge(undefined); setTab('node');
    setNotice('已应用两居一卫住宅预设，可编辑或撤销；保存后生效。');
  };
  const save = async () => {
    setLocalBusy(true);
    try {
      if (!model) {
        const saved = nextResidentialBriefDocument(document, brief);
        localStorage.setItem(`sdd.residentialBriefDraft:${sessionId}`, JSON.stringify(saved));
        setDocument(saved); setDirty(false); setNotice('空间节点草稿已保存在本地；后续可通过 Agent 对话生成方案');
        return saved;
      }
      const saved = await saveResidentialBrief(sessionId,document,brief);
      setDocument(saved); setBrief(saved.brief); setDirty(false); setNotice(saved.version !== document.version ? `需求版本 ${saved.version} 已保存` : layoutDirty ? `节点图布局已保存，需求版本保持 ${saved.version}` : '需求与节点图均已保存');
      return saved;
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); return undefined; }
    finally { setLocalBusy(false); }
  };
  const startEdge = () => { const from=selected??nodes[0]?.id??'';setEdge({ id: uid('rel'), from, to: nodes.find((n) => n.id !== from)?.id ?? '', kind:'direct',priority:'hard' }); setTab('node'); };
  const pendingEdge=!!edge&&JSON.stringify(brief.relations.find(r=>r.id===edge.id))!==JSON.stringify(edge);
  const connectNodes=(connection:Connection,edgeId?:string)=>{
    const {source:from,target:to}=connection;
    if(disabled||from===to||!nodes.some(n=>n.id===from)||!nodes.some(n=>n.id===to))return;
    const existing=edgeId?brief.relations.find(r=>r.id===edgeId):brief.relations.find(r=>(r.from===from&&r.to===to)||(r.kind!=='public_access'&&r.from===to&&r.to===from));
    if(edgeId&&!existing)return;
    const handles={from:connection.sourceHandle==='left'?'left' as const:'right' as const,to:connection.targetHandle==='right'?'right' as const:'left' as const};
    const relation=edgeId?{...existing!,from,to,diagramHandles:handles}:existing??{id:uid('rel'),from,to,kind:'direct' as const,priority:'hard' as const,diagramHandles:handles};
    setEdge(relation);setTab('node');setSelected(from);setNotice(existing&&!edgeId?'已打开已有关系':'请设置关系类型与优先级，然后应用关系');
  };
  const deleteGraph=(nodeIds:string[],edgeIds:string[])=>{
    const removed=new Set(nodeIds.filter(id=>brief.rooms.some(r=>r.id===id)));
    update({...brief,rooms:brief.rooms.filter(r=>!removed.has(r.id)),relations:brief.relations.filter(r=>!edgeIds.includes(r.id)&&!removed.has(r.from)&&!removed.has(r.to))});
    if(selected&&removed.has(selected))setSelected(undefined);
    if(edge&&(edgeIds.includes(edge.id)||removed.has(edge.from)||removed.has(edge.to)))setEdge(undefined);
    setNotice('已删除选中元素及相关关系，尚未保存');
  };
  const applyEdge = () => {
    if (!edge || !edge.from || !edge.to || edge.from===edge.to) { setNotice('请选择两个不同节点'); return; }
    const duplicate=brief.relations.find(r=>r.id!==edge.id&&r.kind===edge.kind&&((r.from===edge.from&&r.to===edge.to)||(edge.kind!=='public_access'&&r.from===edge.to&&r.to===edge.from)));
    if(duplicate){setEdge(duplicate);setNotice('这两个节点已有同类型关系，请编辑已有关系');return;}
    update({ ...brief, relations: brief.relations.some(relation => relation.id === edge.id)
      ? brief.relations.map(relation => relation.id === edge.id ? edge : relation) : [...brief.relations, edge] }); setNotice('关系已更新，尚未保存');
  };

  return <section className="space-editor" aria-label="生成前空间节点图">
    <header className="space-editor-header">
      <div><h2>空间节点图</h2><p>定义房间需求与空间关系，再交给 Agent 生成。节点位置只表示关系图排版。</p></div>
      <div className="space-editor-actions">
        <button disabled={disabled || pendingEdge} onClick={() => void save()}>{dirty ? '保存需求 · 未保存' : layoutDirty ? '保存节点图布局' : '保存需求'}</button>
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
        <SpaceGraphCanvas brief={brief} anchors={anchors} disabled={disabled} selectedRoomId={selected} selectedEdgeId={edge?.id} draft={edge}
          storageKey={`sdd.graphViewport:${sessionId}:${brief.baseRevisionId}`}
          onMove={positions=>update({...brief,rooms:brief.rooms.map(r=>{const p=positions.find(p=>p.id===r.id);return p?{...r,position:{x:p.x,y:p.y}}:r;})})}
          onSelectNode={id=>{setSelected(id);setEdge(undefined);setTab('node');onSelectRoom?.(id);}}
          onSelectEdge={id=>{const relation=brief.relations.find(r=>r.id===id);if(relation){setEdge(relation);setTab('node');}}}
          onConnect={connectNodes} onDelete={deleteGraph} onCancel={()=>{setEdge(undefined);setSelected(undefined);setNotice('已取消操作并清除选中');}}/>
        <div className="space-graph-key"><span>滚轮缩放 · 拖动画布平移</span><span>连接点附近吸附 · 拖动节点按网格吸附</span><span>Shift多选 · Delete／Backspace删除 · Esc取消</span></div>
        <details className="space-checks" open={errors.length>0}><summary>{model ? `空间需求检查 · ${errors.length} 个错误 · ${issues.filter((i) => i.level==='warning').length} 个提示` : '空间需求检查 · 可独立编辑'}</summary>
          <ul>{issues.map((issue,i) => <li key={i} className={issue.level==='error'?'space-error':''}><button onClick={() => {if(issue.nodeId){setSelected(issue.nodeId);setTab('node');setEdge(undefined);}}}>{issue.message}</button></li>)}</ul>
          {!model && <p>节点图仅描述房间与关系；关联建筑底图后的空间可行性校验在方案生成阶段进行。</p>}
          {model && !issues.length && <p>需求可以提交。几何可行性和性能达标情况需要在生成后验证。</p>}
        </details>
        <p className="space-editor-notice" role="status">{notice}</p>
      </div>
      <aside className="space-inspector">
        <div className="space-inspector-tabs"><button className={tab==='node'?'active':''} onClick={() => setTab('node')}>节点与关系</button><button className={tab==='layout'?'active':''} onClick={() => setTab('layout')}>布局参数</button></div>
        <fieldset disabled={disabled}>
          {tab==='layout' ? <>
            <legend>布局使用要求</legend><p className="space-muted">网格用于初步分配，最终计算墙厚与精确净边界。以下是可编辑的设计参数，不代表规范认证；房间形状和尾部通常作为品质提示。</p>
            {(['gridSize','passageWidth','doorWidth','doorDepth'] as const).map((key,i)=><label key={key}>{['布局网格尺寸','通行净宽','新增门宽','门前净空深度'][i]}（m）<input type="number" min={key==='gridSize'?.2:.6} max={key==='gridSize'?1:key==='doorWidth'?1.5:2} step="0.1" value={layoutSettings(brief)[key]} onChange={e=>update({...brief,layout:{...layoutSettings(brief),[key]:Number(e.target.value)}})}/></label>)}
            <label>普通隔墙厚度（mm）<input type="number" min="60" max="500" step="10" value={layoutSettings(brief).partitionThickness*1000} onChange={e=>update({...brief,layout:{...layoutSettings(brief),partitionThickness:Number(e.target.value)/1000}})}/></label>
            <p className="space-muted">直线续接承重墙的隔墙自动沿用承重墙厚度与中心线；转角及T接按实际墙面衔接。</p>
            <p className="space-muted">独立走廊按需生成；客餐厅可以承担通行。默认不对房间强加家具主体尺寸，可在各房间节点设置。</p>
            <details><summary>保留开放空间中的承重墙</summary>
              <p className="space-muted">如需有意保留墙垛，请填写用途；其余墙段优先作为空间分界组织。</p>
              {model?.walls.filter(w=>w.fixed&&w.role==='structural').map(w=><label key={w.id}>{w.id} 的保留用途<input maxLength={500} value={brief.structuralWallUses?.find(u=>u.wallId===w.id)?.purpose??''} placeholder="例如客餐厅之间的展示墙" onChange={e=>{const uses=(brief.structuralWallUses??[]).filter(u=>u.wallId!==w.id);if(e.target.value.trim())uses.push({wallId:w.id,purpose:e.target.value});update({...brief,structuralWallUses:uses});}}/></label>)}
            </details>
          </> : edge ? <>
            <legend>{brief.relations.some((e) => e.id===edge.id)?'编辑关系':'添加关系'}</legend>
            <label>起点<select value={edge.from} onChange={(e) => setEdge({...edge,from:e.target.value})}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
            <label>终点<select value={edge.to} onChange={(e) => setEdge({...edge,to:e.target.value})}>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></label>
            <label>关系<select value={edge.kind} onChange={(e) => setEdge({...edge,kind:e.target.value as RoomRelation['kind']})}>{Object.entries(RELATION_LABELS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <p className="space-muted">{edge.kind==='direct'?'必须通过门或开放通道直接连接。':edge.kind==='adjacent'?'共享边界，不要求开门。':edge.kind==='public_access'?'从起点可经允许穿行的房间或交通空间到达终点。':'可以相邻，但不能直接开门或形成开放通道。'}</p>
            <label>优先级<select value={edge.priority} onChange={(e) => setEdge({...edge,priority:e.target.value as RoomRelation['priority']})}><option value="hard">必须满足</option><option value="soft">尽量满足</option></select></label>
            <button className="space-primary" onClick={applyEdge}>应用关系</button><button onClick={()=>{setEdge(undefined);setNotice('已关闭关系编辑');}}>取消编辑</button>
            {pendingEdge&&<p className="space-muted">关系尚未应用，应用后再保存需求或生成。</p>}
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
            <hr/><button onClick={startEdge}>为此房间添加关系</button>
            <button className="space-danger" onClick={() => {update({...brief,rooms:brief.rooms.filter((r) => r.id!==room.id),relations:brief.relations.filter((e) => e.from!==room.id&&e.to!==room.id)});setSelected(undefined);}}>删除房间及相关关系</button>
          </> : <><legend>选择节点</legend><p>点击房间设置需求，或在房间之间创建连接关系。生成方案请在 Agent 对话中提出。</p><button disabled={nodes.length<2} onClick={startEdge}>添加关系</button></>}
        </fieldset>
        <label className="space-notes">补充设计要求<textarea disabled={disabled} value={brief.notes} maxLength={4000} rows={3} onChange={(e) => update({...brief,notes:e.target.value})} placeholder="例如主卧安静、避免穿越卧室…" /></label>
      </aside>
    </div>
  </section>;
}
