import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closePolygon } from '../src/model/geometry';
import { validateModel } from '../src/model/validate';

test('validateModel 拒绝边线穿出凹口的功能区', () => {
  const lFloor = closePolygon([
    [0, 0],
    [40, 0],
    [40, 30],
    [26, 30],
    [26, 20],
    [16, 20],
    [16, 30],
    [0, 30],
    [0, 0],
  ]);
  const v = validateModel({
    model: { schemaVersion: '1', revisionId: 'rev-0001', units: 'm', origin: [0, 0] },
    floor: {
      boundary: lFloor,
      elevation: 0,
      height: 3,
      topObstruction: false,
      bottomObstruction: false,
    },
    spaceTypes: [{ id: 'dining', label: '散台区', color: '#FFE4A8' }],
    spaces: [
      {
        id: 'sp-dining',
        typeId: 'dining',
        usage: '散台区',
        boundary: closePolygon([
          [15, 22],
          [27, 22],
          [27, 28],
          [15, 28],
          [15, 22],
        ]),
        targetArea: 0,
        performancePreferences: {},
      },
    ],
    walls: [],
    openings: [],
    doors: [],
    windows: [],
    fixedContext: [],
    externalContext: [],
  });
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes('穿出') || e.includes('超出')));
});
