import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPABILITIES, RESIDENTIAL_SCENARIO, createResidentialPreset } from '@sdd/shared';
import { listScenarioDefinitions, prepareScenarioGeneration } from '../src/scenarios/registry';
import { prepareResidentialTurn } from '../src/scenarios/residential';
import { parseFixedEnvelopeDxf } from '../src/dxf/fixedEnvelope';

test('only implemented scenes are discoverable and their analysis capabilities exist',()=>{
  const definitions=listScenarioDefinitions();assert.deepEqual(definitions,[RESIDENTIAL_SCENARIO]);
  for(const definition of definitions)for(const id of definition.defaultAnalysisIds)assert.ok(CAPABILITIES.some(c=>c.id===id&&c.enabled));
  Object.assign(definitions[0],{label:'changed'});assert.equal(listScenarioDefinitions()[0].label,RESIDENTIAL_SCENARIO.label);
  assert.throws(()=>prepareScenarioGeneration('unused',{id:'office',version:'1',input:{}}),/不支持/);
  assert.throws(()=>prepareScenarioGeneration('unused',{id:'residential',version:'2',input:{}}),/版本不匹配/);
});

test('a prepared scene freezes its demand and base before execution and records its definition',async t=>{
  const base=parseFixedEnvelopeDxf(fs.readFileSync(new URL('../../examples/inputs/residential-fixed-envelope/residential-fixed-envelope.dxf',import.meta.url),'utf8'),'fixed.dxf');
  base.model.revisionId='rev-0001';
  const document={brief:createResidentialPreset('rev-0001','D1'),version:1,baseModelHash:'test',updatedAt:''};
  const before=structuredClone(document),prepared=prepareResidentialTurn(base,document);
  document.brief.notes='later edit';base.walls[0].thickness=99;
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'sdd-scene-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  let calls=0;
  const result=await prepared.generate({cwd,revisionId:'rev-0002'},{id:'echo',async run(){calls++;return {failed:true};}},()=>{});
  assert.equal(calls,1);assert.equal(result.failed,true);assert.notEqual(prepared.base.walls[0].thickness,99);
  const folder=path.join(cwd,'designs','rev-0002');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'generation-brief.json'),'utf8')),before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'scenario.json'),'utf8')),RESIDENTIAL_SCENARIO);
});
