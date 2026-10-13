import fs from 'node:fs';
import path from 'node:path';
import { legacyStorageHash } from '../../analysis/runtime/identity';
import { daylightSettings, roomDaylight, checkResidentialBrief, createResidentialPreset, parseResidentialBrief, RELATION_LABELS,
  nextResidentialBriefDocument, projectStoredResidentialBrief, storedResidentialBrief, residentialBriefChanges, residentialBriefSemantics,
  type StoredResidentialBriefDocument, type ResidentialBriefDocument, type SpaceModel } from '@sdd/shared';
import { workspacesDir } from '../../config';
import { isAcceptedDesign, loadDesign } from '../../model/store';
import { polygonArea } from '../../geometry/polygon';

function location(sessionId: string, revisionId: string) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId) || !/^rev-\d+$/.test(revisionId)) throw new Error('会话或底图版本无效');
  return path.join(workspacesDir, sessionId, 'designs', revisionId, 'residential-brief.json');
}
export const briefBaseHash = (model: SpaceModel) => legacyStorageHash(model).slice('sha256:'.length);
export function loadResidentialBrief(sessionId: string, revisionId: string): { document: ResidentialBriefDocument; model: SpaceModel } {
  const file = location(sessionId, revisionId);
  const model = loadDesign(sessionId, revisionId);
  if (!model?.model.dxfSource || model.spaces.length || !isAcceptedDesign(sessionId, revisionId, model)) throw new Error('请选择有效的住宅 DXF 固定底图');
  const stored = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : undefined;
  const document: ResidentialBriefDocument = stored ? stored.schemaVersion === '2' ? projectStoredResidentialBrief(stored as StoredResidentialBriefDocument) : stored
    : { brief: createResidentialPreset(revisionId, model.doors[0]?.id), baseModelHash: briefBaseHash(model), version: 0, updatedAt: '' };
  document.brief = parseResidentialBrief(document.brief);
  return { document, model };
}
export function saveResidentialBrief(sessionId: string, revisionId: string, raw: unknown): ResidentialBriefDocument {
  const request = raw as { brief?: unknown; expectedVersion?: unknown; baseModelHash?: unknown; expectedGraphLayoutVersion?: unknown };
  const { document: previous, model } = loadResidentialBrief(sessionId, revisionId);
  if (request?.expectedVersion !== previous.version || request?.baseModelHash !== briefBaseHash(model)) throw new Error('底图或需求已变化，请重新加载后再保存');
  const brief = parseResidentialBrief(request.brief);
  if (brief.baseRevisionId !== revisionId) throw new Error('空间需求与底图版本不一致');
  const layoutVersion = previous.graphLayoutVersion ?? 0;
  if ((request.expectedGraphLayoutVersion !== undefined && request.expectedGraphLayoutVersion !== layoutVersion)
    || (request.expectedGraphLayoutVersion === undefined && layoutVersion > 0 && residentialBriefChanges(previous.brief, brief).layout))
    throw new Error('节点图排版已变化，请重新加载后再保存');
  const document = nextResidentialBriefDocument(previous, brief);
  document.baseModelHash = briefBaseHash(model);
  const file = location(sessionId,revisionId);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(storedResidentialBrief(document),null,2));
  fs.renameSync(`${file}.tmp`,file);
  return document;
}
export function prepareResidentialGeneration(sessionId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('缺少空间需求版本');
  const request = raw as { baseRevisionId?: unknown; version?: unknown; baseModelHash?: unknown };
  if (typeof request.baseRevisionId !== 'string') throw new Error('缺少固定底图版本');
  const { document, model } = loadResidentialBrief(sessionId, request.baseRevisionId);
  if (!document.version || request.version !== document.version || request.baseModelHash !== document.baseModelHash
    || document.baseModelHash !== briefBaseHash(model)) throw new Error('需求尚未保存或底图已变化，请保存最新节点图后再提交');
  const issues = checkResidentialBrief(document.brief, model).filter((i) => i.level === 'error');
  if (issues.length) throw new Error(issues.map((i) => i.message).join('；'));
  return { document, model };
}
export function residentialGenerationMessage(document: ResidentialBriefDocument): string {
  const semantic = residentialBriefSemantics(document.brief);
  return [
    '根据住宅节点图与室内采光指标制定布局策略，再由几何求解器在固定 DXF 中生成平面。',
    '节点图是生成前的需求；position 仅用于图编辑，不是平面坐标。',
    'Agent 提供功能分区、窗与空间位置偏好；算法联合分配网格、门位和通路，不由Agent编写几何。',
    `关系含义：${JSON.stringify(RELATION_LABELS)}。hard 必须满足；soft 为偏好。`,
    '采光 minIlluminanceLux/minAreaRatio/priority 作为策略输入；实际性能在生成后仿真验证。',
    JSON.stringify({...semantic,sunlight:undefined,daylight:daylightSettings(document.brief),rooms:semantic.rooms.map((room,index)=>({...room,sunlight:undefined,daylight:roomDaylight(document.brief.rooms[index])}))},null,2),
  ].join('\n');
}

/** Minimal admission checks: immutable fixed inputs and stable program identity/area. */
export function validateResidentialCandidate(model: SpaceModel, base: SpaceModel, document: ResidentialBriefDocument): string[] {
  const errors: string[] = [];
  if (JSON.stringify(base.floor) !== JSON.stringify(model.floor)) errors.push('住宅固定底图楼层条件被修改');
  for (const key of ['walls','openings','doors','windows','fixedContext','externalContext'] as const) {
    for (const original of base[key]) {
      if (JSON.stringify(model[key].find((item) => item.id === original.id)) !== JSON.stringify(original)) errors.push(`固定构件 ${original.id} 被修改或丢失`);
    }
  }
  const scale = model.model.units === 'mm' ? 1000 : 1;
  for (const room of document.brief.rooms) {
    const spaces = model.spaces.filter((s) => (s.allocationId ?? s.id) === room.id);
    if (!spaces.length) { errors.push(`缺少需求房间 ${room.name}，须保留 ID ${room.id}`); continue; }
    const area = spaces.reduce((n,s) => n+polygonArea(s.boundary)/(scale*scale),0);
    if (area < room.area.min-1e-6 || area > room.area.max+1e-6) errors.push(`${room.name} 实际面积 ${area.toFixed(2)}㎡ 超出 ${room.area.min}～${room.area.max}㎡`);
  }
  return errors;
}
