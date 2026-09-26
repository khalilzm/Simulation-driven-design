import type { SpaceModel, Vec2 } from '@sdd/shared';

export function rectangle(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
}

export function layoutModel(): SpaceModel {
  const boundary = rectangle(0, 0, 10, 8);
  return {
    model: { schemaVersion: '1', revisionId: 'rev-0001', parentRevisionId: null, units: 'm', origin: [100.123456, 200] },
    floor: { boundary, elevation: 0, height: 3, topObstruction: false, bottomObstruction: false },
    spaceTypes: [{ id: 'training', label: '训练区', color: '#A8C8F0' }],
    spaces: [{ id: 'training-1', typeId: 'training', usage: '训练区', boundary, targetArea: 80, performancePreferences: {} }],
    walls: boundary.slice(0, -1).map((point, i) => ({
      id: `wall-${i}`, geometry: { type: 'polyline', points: [point, boundary[i + 1]] },
      thickness: 0.12, height: 3, fixed: false,
    })),
    openings: [], doors: [], windows: [], fixedContext: [], externalContext: [],
  };
}
