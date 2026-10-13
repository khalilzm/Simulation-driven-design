import type { ResidentialBrief, ResidentialBriefDocument, RoomRelation, RoomRequirement } from './residentialBrief';

export interface ResidentialGraphLayout {
  positions: Record<string, RoomRequirement['position']>;
  handles: Record<string, NonNullable<RoomRelation['diagramHandles']>>;
}
export type ResidentialBriefSemantics = Omit<ResidentialBrief, 'rooms' | 'relations'> & {
  rooms: Omit<RoomRequirement, 'position'>[];
  relations: Omit<RoomRelation, 'diagramHandles'>[];
};
export function residentialBriefSemantics(brief: ResidentialBrief): ResidentialBriefSemantics {
  return { ...brief, rooms: brief.rooms.map(({ position: _position, ...room }) => room),
    relations: brief.relations.map(({ diagramHandles: _handles, ...relation }) => relation) };
}
export function residentialGraphLayout(brief: ResidentialBrief): ResidentialGraphLayout {
  return { positions: Object.fromEntries(brief.rooms.map(room => [room.id, { ...room.position }])),
    handles: Object.fromEntries(brief.relations.filter(relation => relation.diagramHandles)
      .map(relation => [relation.id, { ...relation.diagramHandles! }])) };
}
/** UI compatibility projection; physical inputs remain independent of these defaults. */
export function residentialBriefWithLayout(brief: ResidentialBriefSemantics, layout: ResidentialGraphLayout): ResidentialBrief {
  return { ...brief, rooms: brief.rooms.map((room, index) => ({ ...room,
    position: layout.positions[room.id] ?? { x: .35 + index % 3 * .25, y: .22 + Math.floor(index / 3) % 4 * .2 } })),
    relations: brief.relations.map(relation => ({ ...relation,
      ...(layout.handles[relation.id] ? { diagramHandles: layout.handles[relation.id] } : {}) })) };
}
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const sameResidentialBriefSemantics = (a: ResidentialBrief, b: ResidentialBrief) =>
  stableJson(residentialBriefSemantics(a)) === stableJson(residentialBriefSemantics(b));
export function residentialBriefChanges(previous: ResidentialBrief, next: ResidentialBrief) {
  return { semantic: !sameResidentialBriefSemantics(previous, next),
    layout: stableJson(residentialGraphLayout(previous)) !== stableJson(residentialGraphLayout(next)) };
}
/** First explicit save publishes requirements; later no-op and diagram saves do not republish them. */
export function nextResidentialBriefDocument(previous: ResidentialBriefDocument, brief: ResidentialBrief,
  timestamp = new Date().toISOString()): ResidentialBriefDocument {
  const changes = residentialBriefChanges(previous.brief, brief);
  const semantic = changes.semantic || previous.version === 0;
  const layout = changes.layout || previous.version === 0;
  return { brief, baseModelHash: previous.baseModelHash,
    version: previous.version + Number(semantic), updatedAt: semantic ? timestamp : previous.updatedAt,
    graphLayoutVersion: (previous.graphLayoutVersion ?? 0) + Number(layout),
    graphLayoutUpdatedAt: layout ? timestamp : previous.graphLayoutUpdatedAt ?? '' };
}
export interface StoredResidentialBriefDocument {
  schemaVersion: '2';
  semanticBrief: ResidentialBriefSemantics;
  baseModelHash: string; version: number; updatedAt: string;
  graphLayout: { version: number; updatedAt: string; data: ResidentialGraphLayout };
}
export function storedResidentialBrief(document: ResidentialBriefDocument): StoredResidentialBriefDocument {
  return { schemaVersion: '2', semanticBrief: residentialBriefSemantics(document.brief),
    baseModelHash: document.baseModelHash, version: document.version, updatedAt: document.updatedAt,
    graphLayout: { version: document.graphLayoutVersion ?? 0, updatedAt: document.graphLayoutUpdatedAt ?? '', data: residentialGraphLayout(document.brief) } };
}
export function projectStoredResidentialBrief(document: StoredResidentialBriefDocument): ResidentialBriefDocument {
  return { brief: residentialBriefWithLayout(document.semanticBrief, document.graphLayout.data),
    baseModelHash: document.baseModelHash, version: document.version, updatedAt: document.updatedAt,
    graphLayoutVersion: document.graphLayout.version, graphLayoutUpdatedAt: document.graphLayout.updatedAt };
}
