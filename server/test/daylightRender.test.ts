import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DaylightResult} from '@sdd/shared';
import {daylightGridsToFills,DAYLIGHT_SCALE} from '../../web/src/viewer/sunlightMeshRender';
import {hoursToSunlightColor} from '../../web/src/viewer/sunlightColor';
test('照度热力图读取独立lux数组，色标一致，超过上限饱和但原值保留',()=>{
 const result:DaylightResult={schemaVersion:'1',status:'completed',engineVersion:'test',method:'overcast-daylight-factor',outdoorIlluminanceLux:10000,assumptions:[],spaces:[],grids:[{gridId:'g',spaceId:'room-main',vertices:[[0,0,.75],[1,0,.75],[1,1,.75],[0,1,.75]],faces:[[0,1,2,3]],lux:[500],daylightFactors:[5]}]};
 const fills=daylightGridsToFills(result);assert.equal(fills.length,1);assert.equal(fills[0].spaceId,'room-main');assert.equal(fills[0].color,hoursToSunlightColor(500,DAYLIGHT_SCALE));
 result.grids[0].lux[0]=2000;assert.equal(daylightGridsToFills(result)[0].color,hoursToSunlightColor(1000,DAYLIGHT_SCALE));assert.equal(result.grids[0].lux[0],2000);
});
