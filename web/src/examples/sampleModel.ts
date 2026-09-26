import type { SpaceModel } from '@sdd/shared';

// 内置示例方案：验证「上传→校验→版本→平面预览」链路
export const sampleModel: SpaceModel = {
  model: {
    schemaVersion: '1',
    revisionId: 'rev-0001',
    parentRevisionId: null,
    units: 'm',
    origin: [0, 0],
  },
  floor: {
    boundary: [
      [0, 0],
      [12, 0],
      [12, 9],
      [0, 9],
      [0, 0],
    ],
    elevation: 0,
    height: 3,
    topObstruction: false,
    bottomObstruction: false,
  },
  spaceTypes: [
    { id: 'living', label: '客厅', color: '#FFE4A8' },
    { id: 'bedroom', label: '卧室', color: '#A8C8F0' },
  ],
  spaces: [
    {
      id: 'space-1',
      typeId: 'living',
      boundary: [
        [0, 0],
        [6, 0],
        [6, 9],
        [0, 9],
        [0, 0],
      ],
      usage: '客厅',
      targetArea: 54,
      performancePreferences: {},
    },
    {
      id: 'space-2',
      typeId: 'bedroom',
      boundary: [
        [6, 0],
        [12, 0],
        [12, 9],
        [6, 9],
        [6, 0],
      ],
      usage: '卧室',
      targetArea: 54,
      performancePreferences: {},
    },
  ],
  walls: [
    { id: 'wall-1', geometry: { type: 'polyline', points: [[0, 0], [12, 0]] }, thickness: 0.2, height: 3, fixed: true },
    { id: 'wall-2', geometry: { type: 'polyline', points: [[12, 0], [12, 9]] }, thickness: 0.2, height: 3, fixed: true },
    { id: 'wall-3', geometry: { type: 'polyline', points: [[12, 9], [0, 9]] }, thickness: 0.2, height: 3, fixed: true },
    { id: 'wall-4', geometry: { type: 'polyline', points: [[0, 9], [0, 0]] }, thickness: 0.2, height: 3, fixed: true },
    { id: 'wall-5', geometry: { type: 'polyline', points: [[6, 0], [6, 9]] }, thickness: 0.2, height: 3, fixed: false },
  ],
  openings: [
    { id: 'opening-entrance', hostWallId: 'wall-1', position: 2, width: 1.2, height: 2.1, fillRef: 'door-entrance' },
    { id: 'opening-1', hostWallId: 'wall-5', position: 4.5, width: 1.2, height: 2.1, fillRef: 'door-1' },
  ],
  doors: [
    { id: 'door-entrance', openingId: 'opening-entrance', swing: 'left', leafCount: 1, analysisProperties: {} },
    { id: 'door-1', openingId: 'opening-1', swing: 'left', leafCount: 2, analysisProperties: {} },
  ],
  windows: [],
  fixedContext: [],
  externalContext: [],
};
