import { rectangle } from './spaceModel';

/** schemaVersion 3：拓扑引用（无裸坐标） */
export function v3Layout(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 3,
    vertices: [
      { id: 'mid_s', edge: 0, t: 0.5 },
      { id: 'mid_n', edge: 2, t: 0.5 },
    ],
    spaces: [
      { id: 'hall', usage: '门厅', enclosed: false, loop: ['V0', 'mid_s', 'mid_n', 'V3'] },
      { id: 'studio', usage: '教室', enclosed: true, loop: ['mid_s', 'V1', 'V2', 'mid_n'] },
    ],
    boundaries: [{
      id: 'split',
      from: 'mid_s',
      to: 'mid_n',
      kind: 'wall',
      leftSpaceId: 'hall',
      rightSpaceId: 'studio',
    }],
    openings: [{ id: 'o1', hostBoundaryId: 'split', position: 4, width: 1, height: 2.1 }],
    doors: [{ id: 'd1', openingId: 'o1', swing: 'left', connects: ['hall', 'studio'] }],
    windows: [],
    ...overrides,
  };
}
