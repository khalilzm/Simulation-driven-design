import type {
  WorkspaceCanvasDocument,
  ScenarioDefinition,
  ScenarioGenerationRequest,
  Capability,
  ProviderId,
  ProviderInfo,
  SpaceModel,
  StreamEvent,
  SketchSource,
  SketchReport,
  SpaceTaskMode,
  OptimizationRequest,
  OptimizationEvent,
  OptimizationRun,
  AutomaticOptimizationRequest,
  OptimizationComparison,
  OptimizationSetup, WorkbenchAnalysis, WorkbenchAnalysisRequest,
  OptimizationTaskDraft, OptimizationTaskInterpretation,
  OptimizationAnalysisView,
  DxfUploadResponse,
  ResidentialBrief,
  ResidentialBriefDocument,
} from '@sdd/shared';

export async function loadCanvasDocument(sessionId: string): Promise<WorkspaceCanvasDocument | null> {
  const response = await fetch(`/api/canvas/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error('画布恢复失败');
  return response.json();
}
export async function saveCanvasDocument(sessionId: string, snapshot: unknown): Promise<void> {
  const response = await fetch(`/api/canvas/${encodeURIComponent(sessionId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot }),
  });
  if (!response.ok) throw new Error('画布保存失败，布局仍保留在本机');
}

export interface StatusResponse {
  providers: ProviderInfo[];
  capabilities: Capability[];
  scenarios: ScenarioDefinition[];
}

export async function fetchStatus(): Promise<StatusResponse> {
  const r = await fetch('/api/status');
  if (!r.ok) throw new Error(`获取状态失败: ${r.status}`);
  return r.json();
}

async function streamNdjson(r: Response, onEvent: (e: StreamEvent) => void): Promise<void> {
  if (!r.ok) { const body = await r.json().catch(()=>({})); throw new Error(body.error ?? `请求失败: ${r.status}`); }
  if (!r.body) throw new Error('生成连接没有返回数据');
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let completed = false;
  try { for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_,reject) => { timer=setTimeout(() => {
      void reader.cancel().catch(()=>{});
      reject(new Error('生成连接超过120秒没有数据，可能已中断，请重新提交'));
    },120000); });
    const { done, value } = await Promise.race([reader.read(),timeout]).finally(()=>clearTimeout(timer));
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const event = JSON.parse(line) as StreamEvent;
      onEvent(event);
      if(event.type==='done') completed=true;
    }
    if(completed) break;
  }
  if(!completed) throw new Error('生成连接在完成前中断，可能发生服务重启，请重新提交');
  } finally { void reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

export async function streamChat(
  body: { provider: ProviderId; sessionId?: string; message: string; parentRevisionId?: string | null; mode?: SpaceTaskMode; sketchId?: string; requirePreparedInputs?: boolean; scenario?: ScenarioGenerationRequest; residentialBrief?: { baseRevisionId: string; version: number; baseModelHash: string } },
  onEvent: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  await streamNdjson(r, onEvent);
}

export function inputFileUrl(sessionId: string, name: string): string {
  return `/api/files/${sessionId}/${encodeURIComponent(name)}`;
}

/** 上传手绘草图到会话 inputs/（PNG/JPEG/WebP） */
export async function uploadSketch(
  sessionId: string | undefined,
  filename: string,
  contentBase64: string,
): Promise<{ sessionId: string; file: { name: string; size: number }; sketch: SketchSource }> {
  const r = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filename, contentBase64 }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `上传失败: ${r.status}`);
  return j as { sessionId: string; file: { name: string; size: number }; sketch: SketchSource };
}

/** Parse and persist a fixed-envelope DXF as a model revision, without an Agent call. */
export async function uploadDxf(sessionId: string | undefined, filename: string, contentBase64: string): Promise<DxfUploadResponse> {
  const r = await fetch('/api/uploads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filename, contentBase64 }),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? `DXF 上传失败: ${r.status}`);
  return result as DxfUploadResponse;
}

export interface DesignSummary {
  revisionId: string;
  parentRevisionId: string | null;
  createdAt: string;
  valid?: boolean;
  kind?: 'dxf' | 'scheme';
  baseRevisionId?: string;
  briefVersion?: number;
  sketchId?: string;
  sketchStatus?: SketchReport['status'];
}

export async function listDesigns(sessionId: string): Promise<DesignSummary[]> {
  const r = await fetch(`/api/designs/${sessionId}`);
  if (!r.ok) throw new Error(`列出版本失败: ${r.status}`);
  const j = (await r.json()) as { designs: DesignSummary[] };
  return j.designs.filter((design) => design.valid !== false || !!design.sketchId);
}

export interface SaveDesignResult {
  valid: boolean;
  errors: string[];
  revisionId?: string;
}

export async function saveSunlightConfig(
  sessionId: string,
  revisionId: string,
  sunlight: unknown,
): Promise<void> {
  const r = await fetch(`/api/designs/${sessionId}/${revisionId}/sunlight`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sunlight),
  });
  const j = (await r.json()) as { errors?: string[] };
  if (!r.ok) throw new Error(j.errors?.join('；') || `保存日照配置失败: ${r.status}`);
}

export async function saveDesign(
  sessionId: string,
  model: SpaceModel,
  parentRevisionId?: string,
): Promise<SaveDesignResult> {
  const r = await fetch('/api/designs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, model, parentRevisionId }),
  });
  const j = (await r.json()) as SaveDesignResult;
  if (!r.ok) throw new Error(j.errors.join('；') || `保存方案失败: ${r.status}`);
  return j;
}

export async function loadDesign(sessionId: string, revisionId: string): Promise<SpaceModel> {
  const r = await fetch(`/api/designs/${sessionId}/${revisionId}`);
  if (!r.ok) throw new Error(`读取方案失败: ${r.status}`);
  return r.json();
}

export async function savePedestrianConfig(
  sessionId: string,
  revisionId: string,
  pedestrian: unknown,
): Promise<void> {
  const r = await fetch(`/api/designs/${sessionId}/${revisionId}/pedestrian`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pedestrian),
  });
  const j = (await r.json()) as { errors?: string[] };
  if (!r.ok) throw new Error(j.errors?.join('；') || `保存疏散配置失败: ${r.status}`);
}

export async function generate(
  sessionId: string,
  provider: ProviderId,
  onEvent: (e: StreamEvent) => void,
  parentRevisionId?: string | null,
  task?: { mode: SpaceTaskMode; sketchId?: string; requirePreparedInputs?: boolean; scenario?: ScenarioGenerationRequest; residentialBrief?: { baseRevisionId: string; version: number; baseModelHash: string } },
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, provider, parentRevisionId, ...task }),
    signal,
  });
  await streamNdjson(r, onEvent);
}

export async function loadResidentialBrief(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<ResidentialBriefDocument> {
  const response = await fetch(`/api/residential-briefs/${sessionId}/${revisionId}`, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '无法加载空间需求');
  return body;
}

export async function saveResidentialBrief(sessionId: string, document: ResidentialBriefDocument, brief: ResidentialBrief, signal?: AbortSignal): Promise<ResidentialBriefDocument> {
  const response = await fetch(`/api/residential-briefs/${sessionId}/${brief.baseRevisionId}`, {
    method: 'PUT', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief, expectedVersion: document.version, expectedGraphLayoutVersion: document.graphLayoutVersion ?? 0, baseModelHash: document.baseModelHash }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '无法保存空间需求');
  return body;
}

export async function interpretResidentialBrief(provider: ProviderId, sessionId: string, module: 'graph'|'metrics', message: string, brief: ResidentialBrief, signal?: AbortSignal): Promise<{ brief: ResidentialBrief; summary: string }> {
  const response = await fetch('/api/residential-briefs/interpret', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, sessionId, module, message, brief }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Agent 整理需求失败');
  return body;
}

export async function loadSketchReport(sessionId: string, revisionId: string): Promise<SketchReport> {
  const r = await fetch(`/api/sketches/${sessionId}/${revisionId}`);
  if (!r.ok) throw new Error(`读取草图还原记录失败: ${r.status}`);
  return r.json();
}

export async function streamAutomaticOptimization(body: AutomaticOptimizationRequest, signal: AbortSignal,
  onEvent: (event: OptimizationEvent) => void): Promise<void> {
  return streamOptimizationRequest('/api/optimizations/automatic', body, signal, onEvent);
}

async function streamOptimizationRequest(url: string, body: OptimizationRequest | AutomaticOptimizationRequest,
  signal: AbortSignal, onEvent: (event: OptimizationEvent) => void): Promise<void> {
  const response = await fetch(url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error ?? '启动优化失败');
  }
  if (!response.body) throw new Error('优化响应为空');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', terminal = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as OptimizationEvent;
    if (event.type === 'run' && ['completed', 'needs_input', 'cancelled', 'failed', 'interrupted'].includes(event.run.status)) terminal = true;
    if (event.type === 'error') throw new Error(event.message);
    onEvent(event);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    }
    consume(buffer + decoder.decode());
    if (!terminal) throw new Error('优化连接提前结束，重新打开面板可查看保存的结果');
  } finally { reader.releaseLock(); }
}

async function workbenchJson<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '工作台请求失败');
  return data;
}

export const loadOptimizationSetup = (sessionId: string, revisionId: string, signal?: AbortSignal) =>
  workbenchJson<OptimizationSetup>(`/api/optimization-setup/${sessionId}/${revisionId}`, undefined, signal);
export const analyzeWorkbench = (body: WorkbenchAnalysisRequest, signal: AbortSignal) =>
  workbenchJson<WorkbenchAnalysis>('/api/optimization-analysis', body, signal);
export const latestWorkbenchAnalysis = (sessionId: string, revisionId: string, signal?: AbortSignal) =>
  workbenchJson<{ analysis: WorkbenchAnalysis | null }>(`/api/optimization-analysis/${sessionId}/${revisionId}`, undefined, signal);
export const interpretOptimizationTask = (body: AutomaticOptimizationRequest & { message: string; current: OptimizationTaskDraft }, signal: AbortSignal) =>
  workbenchJson<OptimizationTaskInterpretation>('/api/optimization-task', body, signal);
export const loadOptimizationBaselineView = (sessionId: string, runId: string, signal?: AbortSignal) =>
  workbenchJson<OptimizationAnalysisView>(`/api/optimizations/${sessionId}/${runId}/baseline`, undefined, signal);

export async function latestOptimization(sessionId: string, revisionId: string, signal?: AbortSignal): Promise<OptimizationRun | null> {
  const r = await fetch(`/api/optimizations/${sessionId}/latest?revisionId=${encodeURIComponent(revisionId)}`, { signal });
  if (!r.ok) throw new Error('读取优化记录失败');
  return (await r.json()).run;
}

export async function loadOptimizationComparison(sessionId: string, runId: string, candidateId: string): Promise<OptimizationComparison> {
  const r = await fetch(`/api/optimizations/${sessionId}/${runId}/candidates/${candidateId}/comparison`);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? '读取分析对比失败');
  return data;
}

export async function adoptOptimization(sessionId: string, runId: string, candidateId: string,
  expectedBaseRevisionId: string): Promise<string> {
  const r = await fetch(`/api/optimizations/${sessionId}/${runId}/adopt`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidateId, expectedBaseRevisionId }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? '采用候选失败');
  return data.revisionId;
}

export async function loadResidentialSolverReport(sessionId:string,revisionId:string):Promise<import('@sdd/shared').ResidentialSolverDiagnostics> {
  const r=await fetch(`/api/designs/${encodeURIComponent(sessionId)}/${encodeURIComponent(revisionId)}/residential-solver`);
  if(!r.ok)throw new Error('该版本没有可读取的住宅求解报告');return r.json();
}

export async function residentialEvaluation(sessionId:string,revisionId:string,run=false,signal?:AbortSignal):Promise<import('@sdd/shared').ResidentialDaylightRecord|null> {
  const r=await fetch(`/api/designs/${encodeURIComponent(sessionId)}/${encodeURIComponent(revisionId)}/residential-evaluation`,{method:run?'POST':'GET',signal});
  if(!r.ok){const body=await r.json().catch(()=>({}));throw new Error(body.error??'日照评价请求失败');}return r.json();
}
