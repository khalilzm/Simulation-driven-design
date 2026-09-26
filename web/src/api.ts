import type { Capability, ProviderId, ProviderInfo, SpaceModel, StreamEvent } from '@sdd/shared';

export interface StatusResponse {
  providers: ProviderInfo[];
  capabilities: Capability[];
}

export async function fetchStatus(): Promise<StatusResponse> {
  const r = await fetch('/api/status');
  if (!r.ok) throw new Error(`获取状态失败: ${r.status}`);
  return r.json();
}

async function streamNdjson(r: Response, onEvent: (e: StreamEvent) => void): Promise<void> {
  if (!r.ok || !r.body) throw new Error(`请求失败: ${r.status}`);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

export async function streamChat(
  body: { provider: ProviderId; sessionId?: string; message: string },
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await streamNdjson(r, onEvent);
}

export async function uploadDxf(
  sessionId: string | undefined,
  filename: string,
  contentBase64: string,
): Promise<{ sessionId: string; file: { name: string; size: number } }> {
  const r = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filename, contentBase64 }),
  });
  if (!r.ok) throw new Error(`上传失败: ${r.status}`);
  return r.json();
}

export async function fetchFileText(sessionId: string, name: string): Promise<string> {
  const r = await fetch(`/api/files/${sessionId}/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`读取文件失败: ${r.status}`);
  return r.text();
}

export interface DesignSummary {
  revisionId: string;
  parentRevisionId: string | null;
  createdAt: string;
}

export async function listDesigns(sessionId: string): Promise<DesignSummary[]> {
  const r = await fetch(`/api/designs/${sessionId}`);
  if (!r.ok) throw new Error(`列出版本失败: ${r.status}`);
  const j = (await r.json()) as { designs: DesignSummary[] };
  return j.designs;
}

export interface SaveDesignResult {
  valid: boolean;
  errors: string[];
  revisionId?: string;
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

export async function generate(
  sessionId: string,
  provider: ProviderId,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, provider }),
  });
  await streamNdjson(r, onEvent);
}
