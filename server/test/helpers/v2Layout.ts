import { rectangle } from './spaceModel';

export function v2Layout(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    spaces: [{ id: 'training', usage: '训练区', enclosed: false, boundary: rectangle(0, 0, 10, 8).slice(0, -1) }],
    boundaries: [],
    openings: [],
    doors: [],
    windows: [],
    assumptions: [],
    unmetRequirements: [],
    ...overrides,
  };
}
