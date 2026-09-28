import type {
  Capability,
  ProviderId,
  ProviderInfo,
  SpaceModel,
  StreamEvent,
  SunlightConfig,
  SunlightResult,
} from '@sdd/shared';

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
  body: { provider: ProviderId; sessionId?: string; message: string; parentRevisionId?: string | null },
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
): Promise<{ sessionId: string; file: { name: string; size: number } }> {
  const r = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, filename, contentBase64 }),
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `上传失败: ${r.status}`);
  return j as { sessionId: string; file: { name: string; size: number } };
}

/** @deprecated 使用 uploadSketch */
export const uploadDxf = uploadSketch;

export async function fetchFileText(sessionId: string, name: string): Promise<string> {
  const r = await fetch(`/api/files/${sessionId}/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`读取文件失败: ${r.status}`);
  return r.text();
}

export interface DesignSummary {
  revisionId: string;
  parentRevisionId: string | null;
  createdAt: string;
  valid?: boolean;
}

export async function listDesigns(sessionId: string): Promise<DesignSummary[]> {
  const r = await fetch(`/api/designs/${sessionId}`);
  if (!r.ok) throw new Error(`列出版本失败: ${r.status}`);
  const j = (await r.json()) as { designs: DesignSummary[] };
  return j.designs.filter((design) => design.valid !== false);
}

export interface SaveDesignResult {
  valid: boolean;
  errors: string[];
  revisionId?: string;
}

export async function fetchSunlightDemoPass(): Promise<{ model: SpaceModel; sunlight: unknown }> {
  const r = await fetch('/api/examples/sunlight-demo-pass');
  if (!r.ok) throw new Error(`加载日照示例失败: ${r.status}`);
  return r.json() as Promise<{ model: SpaceModel; sunlight: unknown }>;
}

export async function patchDesignFloor(
  sessionId: string,
  revisionId: string,
  floor: { elevation: number; height: number },
): Promise<void> {
  const r = await fetch(`/api/designs/${sessionId}/${revisionId}/floor`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(floor),
  });
  const j = (await r.json()) as { errors?: string[] };
  if (!r.ok) throw new Error(j.errors?.join('；') || `保存楼层参数失败: ${r.status}`);
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

export interface SunlightRunResponse {
  taskId: string;
  inputHash: string;
  simulationDir: string;
  /** 本次是否自动从示例生成了 designs/…/sunlight.json */
  sunlightConfigCreated?: boolean;
  config: SunlightConfig;
  result: SunlightResult;
}

export async function loadSunlightConfig(
  sessionId: string,
  revisionId: string,
): Promise<SunlightConfig | null> {
  const r = await fetch(`/api/designs/${sessionId}/${revisionId}/sunlight`);
  if (r.status === 404) return null;
  const j = (await r.json()) as { config?: SunlightConfig; errors?: string[] };
  if (!r.ok) throw new Error(j.errors?.join('；') || `读取日照配置失败: ${r.status}`);
  if (!j.config) throw new Error('日照配置响应无效');
  return j.config;
}

export async function runSunlight(sessionId: string, revisionId: string): Promise<SunlightRunResponse> {
  const r = await fetch('/api/sunlight/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, revisionId }),
  });
  const j = (await r.json()) as SunlightRunResponse & { error?: string; hint?: string };
  if (!r.ok) {
    const msg = [j.error, j.hint].filter(Boolean).join(' — ');
    throw new Error(msg || `日照分析失败: ${r.status}`);
  }
  return j;
}

export async function checkSunlight(): Promise<{ capability: Capability; python: { ok: boolean; error?: string } }> {
  const r = await fetch('/api/sunlight/check');
  if (!r.ok) throw new Error(`检查日照环境失败: ${r.status}`);
  return r.json();
}

export async function generate(
  sessionId: string,
  provider: ProviderId,
  onEvent: (e: StreamEvent) => void,
  parentRevisionId?: string | null,
): Promise<void> {
  const r = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, provider, parentRevisionId }),
  });
  await streamNdjson(r, onEvent);
}
