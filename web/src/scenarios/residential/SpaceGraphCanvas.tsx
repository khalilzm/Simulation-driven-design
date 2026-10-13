import { committedGraphPositions, GRAPH_WIDTH, GRAPH_HEIGHT } from '../../components/spaceGraphPositions';
import { memo, useEffect, useMemo, useRef } from 'react';
import { Background, BackgroundVariant, ConnectionMode, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useStoreApi, useReactFlow, useNodesInitialized, type Connection, type Edge, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import { RELATION_LABELS, type ResidentialBrief, type RoomKind, type RoomRelation } from '@sdd/shared';
import '@xyflow/react/dist/style.css';
import './SpaceNodeEditor.css';

const COLORS:Record<RoomKind,string>={living:'#7b998b',bedroom:'#7d90b4',kitchen:'#bc9569',bathroom:'#759da8',study:'#9d86ad',balcony:'#8bab83',circulation:'#92988d',other:'#9a9187'};
const WIDTH=GRAPH_WIDTH,HEIGHT=GRAPH_HEIGHT;
const NODE_ORIGIN:[number,number]=[.5,.5];
const SNAP_GRID:[number,number]=[20,20];
type CardData={name:string;color:string;anchor:boolean;area?:string;disabled:boolean};
type FlowNode=Node<CardData,'space'>;
type FlowEdge=Edge<{draft:boolean}>;
interface Props {
  preview?:boolean;
  brief:ResidentialBrief;anchors:{id:string;name:string;x:number;y:number}[];disabled:boolean;
  selectedRoomId?:string;selectedEdgeId?:string;draft?:RoomRelation;storageKey:string;
  onMove:(positions:{id:string;x:number;y:number}[])=>void;onSelectNode:(id:string)=>void;onSelectEdge:(id:string)=>void;
  onConnect:(connection:Connection,edgeId?:string)=>void;onDelete:(nodeIds:string[],edgeIds:string[])=>void;onCancel:()=>void;
}
function SpaceCard({data,selected}:NodeProps<FlowNode>) {
  return <div className={`space-flow-card${data.anchor?' space-flow-card--anchor':''}${selected?' selected':''}`} style={{borderTopColor:data.color}}>
    <Handle type="source" position={Position.Left} id="left" isConnectable={!data.disabled} aria-label={`${data.name}左连接点`}/>
    <strong>{data.name||'未命名空间'}</strong>
    {data.anchor?<span>固定底图接口</span>:<span>{data.area}</span>}
    <Handle type="source" position={Position.Right} id="right" isConnectable={!data.disabled} aria-label={`${data.name}右连接点`}/>
  </div>;
}
const nodeTypes={space:memo(SpaceCard)};
function readViewport(key:string):Viewport|undefined {
  try{const value=JSON.parse(localStorage.getItem(key)??'null');if(value&&[value.x,value.y,value.zoom].every(Number.isFinite)&&value.zoom>=.15&&value.zoom<=3)return value;}catch{/* Optional browser preference */}return undefined;
}
function Graph(props:Props) {
  const [nodes,setNodes,onNodesChange]=useNodesState<FlowNode>([]),[edges,setEdges,onEdgesChange]=useEdgesState<FlowEdge>([]);
  const store=useStoreApi();const container=useRef<HTMLDivElement>(null);
  const initialViewport=useMemo(()=>props.preview?undefined:readViewport(props.storageKey),[props.storageKey,props.preview]);
  const flow=useReactFlow();const initialized=useNodesInitialized();
  useEffect(()=>{
    if(!props.preview||!initialized||!container.current)return;
    let frame=0;
    const fit=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{void flow.fitView({padding:.12,minZoom:.01,maxZoom:1.2});});};
    const observer=new ResizeObserver(fit);observer.observe(container.current);fit();
    return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[props.preview,initialized,props.brief,props.anchors,flow]);
  useEffect(()=>{
    setNodes(previous=>{
      const byId=new Map(previous.map(n=>[n.id,n]));
      const rooms=props.brief.rooms.map(r=>{
        const current=byId.get(r.id);
        return {...current,id:r.id,type:'space' as const,position:current?.dragging?current.position:{x:r.position.x*WIDTH,y:r.position.y*HEIGHT},selected:byId.get(r.id)?.selected??r.id===props.selectedRoomId,draggable:!props.disabled,deletable:!props.disabled,ariaLabel:r.name,data:{name:r.name,color:COLORS[r.kind],anchor:false,disabled:props.disabled,area:`${r.area.min}～${r.area.max}㎡`}};
      });
      return [...props.anchors.map(a=>({...byId.get(a.id),id:a.id,type:'space' as const,position:{x:a.x*WIDTH,y:a.y*HEIGHT},selected:byId.get(a.id)?.selected??a.id===props.selectedRoomId,draggable:false,deletable:false,ariaLabel:a.name,data:{name:a.name,color:'#c99451',anchor:true,disabled:props.disabled}})),...rooms];
    });
  },[props.brief,props.anchors,props.disabled,setNodes]);
  useEffect(()=>{if(props.selectedRoomId)setNodes(ns=>ns.map(n=>({...n,selected:n.id===props.selectedRoomId})));},[props.selectedRoomId,setNodes]);
  useEffect(()=>{
    setEdges(previous=>{
      const byId=new Map(previous.map(e=>[e.id,e]));
      const relations=props.brief.relations.map(r=>props.draft?.id===r.id?props.draft:r);
      if(props.draft&&!relations.some(r=>r.id===props.draft!.id))relations.push(props.draft);
      return relations.filter(r=>r.from!==r.to).map(r=>{
        const from=props.brief.rooms.find(n=>n.id===r.from)?.position??props.anchors.find(n=>n.id===r.from),to=props.brief.rooms.find(n=>n.id===r.to)?.position??props.anchors.find(n=>n.id===r.to);
        const side=(from?.x??0)<=(to?.x??1)?'right':'left',draft=JSON.stringify(props.brief.relations.find(v=>v.id===r.id))!==JSON.stringify(r),color=draft?'#c68c36':r.kind==='no_direct'?'#b66b5b':r.kind==='public_access'?'#7897af':'#6a8a78';
        return {id:r.id,source:r.from,target:r.to,sourceHandle:r.diagramHandles?.from??side,targetHandle:r.diagramHandles?.to??(side==='right'?'left':'right'),type:'smoothstep',label:`${draft?'待应用 · ':''}${RELATION_LABELS[r.kind]}`,selected:byId.get(r.id)?.selected??r.id===props.selectedEdgeId,deletable:!props.disabled&&!draft,reconnectable:!props.disabled&&!draft,data:{draft},style:{stroke:color,strokeWidth:2,strokeDasharray:draft||r.priority==='soft'?'6 5':undefined},markerEnd:r.kind==='public_access'?{type:MarkerType.ArrowClosed,color}:undefined,labelStyle:{fontSize:11,fill:'#394842'},labelBgStyle:{fill:'#fdfdfa',fillOpacity:.95},labelBgPadding:[6,4] as [number,number]};
      });
    });
  },[props.brief,props.anchors,props.draft,props.disabled,setEdges]);
  useEffect(()=>{if(props.selectedEdgeId)setEdges(es=>es.map(e=>({...e,selected:e.id===props.selectedEdgeId})));},[props.selectedEdgeId,setEdges]);
  useEffect(()=>{
    const handler=(e:KeyboardEvent)=>{
      if(e.key!=='Escape'||!container.current?.contains(window.document.activeElement))return;
      store.getState().cancelConnection();setNodes(ns=>ns.map(n=>({...n,selected:false})));setEdges(es=>es.map(edge=>({...edge,selected:false})));props.onCancel();
    };
    window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);
  },[props.onCancel,store,setNodes,setEdges]);
  useEffect(()=>{if(props.disabled)store.getState().cancelConnection();},[props.disabled,store]);
  return <div className="space-react-flow" ref={container} tabIndex={-1} aria-label="可缩放空间节点画布">
    <ReactFlow<FlowNode,FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodeOrigin={NODE_ORIGIN} onNodesChange={changes=>{
      onNodesChange(changes);
      if(props.disabled)return;
      const positions=committedGraphPositions(changes,new Set(props.brief.rooms.map(r=>r.id)));
      if(positions.length)props.onMove(positions);
    }} onEdgesChange={onEdgesChange} onNodeClick={(e,n)=>{if(!e.shiftKey&&!e.metaKey&&!e.ctrlKey)props.onSelectNode(n.id);}} onEdgeClick={(e,edge)=>{if(!e.shiftKey&&!e.metaKey&&!e.ctrlKey)props.onSelectEdge(edge.id);}} onConnectStart={()=>container.current?.focus({preventScroll:true})} onConnect={c=>props.onConnect(c)} onReconnect={(e,c)=>props.onConnect(c,e.id)}
      onDelete={({nodes:deletedNodes,edges:deletedEdges})=>{if(!props.disabled)props.onDelete(deletedNodes.map(n=>n.id),deletedEdges.filter(e=>!e.data?.draft).map(e=>e.id));}}
      isValidConnection={c=>!props.disabled&&c.source!==c.target} connectionMode={ConnectionMode.Loose} connectionRadius={28}
      nodesDraggable={!props.disabled} nodesConnectable={!props.disabled} edgesReconnectable={!props.disabled} deleteKeyCode={props.disabled?null:['Delete','Backspace']} multiSelectionKeyCode={['Shift','Meta','Control']}
      panOnDrag={!props.preview} zoomOnScroll={!props.preview} zoomOnPinch={!props.preview} zoomOnDoubleClick={!props.preview} nodesFocusable={!props.preview} edgesFocusable={!props.preview} elementsSelectable={!props.preview}
      snapToGrid snapGrid={SNAP_GRID} minZoom={props.preview?.01:.15} maxZoom={3} defaultViewport={initialViewport} fitView={!initialViewport} fitViewOptions={{padding:.2,minZoom:.15,maxZoom:1.2}}
      onMoveEnd={(_e,viewport)=>{if(props.preview)return;try{localStorage.setItem(props.storageKey,JSON.stringify(viewport));}catch{/* optional preference */}}}>
      <Background variant={BackgroundVariant.Dots} gap={20} color="#ccd4cd"/>{!props.preview&&<Controls showInteractive={false} fitViewOptions={{padding:.2,minZoom:.15,maxZoom:1.2}}/>}
    </ReactFlow>
  </div>;
}
export function SpaceGraphCanvas(props:Props) {return <ReactFlowProvider><Graph {...props}/></ReactFlowProvider>;}
