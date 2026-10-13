import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefTurnPlan, briefTurnReply, createResidentialBrief, createResidentialPreset, revealedBriefBoards } from '@sdd/shared';

test('a spatial description plans only the node-graph board', () => {
  const plan = briefTurnPlan('两居，主卧连通客厅，厨房相邻', 0);
  assert.deepEqual(plan.modules, ['graph']);
  assert.equal(plan.reply, undefined);
});

test('a metric request before any rooms asks for the node graph and creates no board', () => {
  const plan = briefTurnPlan('主卧采光不少于 300 lx', 0);
  assert.deepEqual(plan.modules, []);
  assert.match(plan.reply ?? '', /房间/);
});

test('metrics attach only after rooms exist, and one sentence can plan both boards', () => {
  assert.deepEqual(briefTurnPlan('主卧日照不少于 2 小时', 2).modules, ['metrics']);
  assert.deepEqual(briefTurnPlan('三居，客厅连通厨房，主卧采光 300 lx', 0).modules, ['graph', 'metrics']);
  assert.deepEqual(briefTurnPlan('生成方案', 2).modules, []);
});

test('boards appear only when the interpreted brief actually contains that artifact', () => {
  const empty = createResidentialBrief('rev-1');
  const preset = createResidentialPreset('rev-1');
  const withoutTargets = structuredClone(preset);
  withoutTargets.rooms.forEach(room => { room.daylight = { ...room.daylight!, enabled: false }; });
  assert.deepEqual(revealedBriefBoards(['graph'], empty), []);
  assert.deepEqual(revealedBriefBoards(['graph'], preset), ['graph']);
  assert.deepEqual(revealedBriefBoards(['graph'], withoutTargets), ['graph']);
  assert.deepEqual(revealedBriefBoards(['metrics'], withoutTargets), []);
  assert.deepEqual(revealedBriefBoards(['graph', 'metrics'], preset), ['graph', 'metrics']);
});

test('the reply names only the boards that were actually created', () => {
  assert.match(briefTurnReply(['graph', 'metrics'], ['graph']), /节点图/);
  assert.match(briefTurnReply(['graph', 'metrics'], ['graph']), /指标白板暂不生成/);
  assert.doesNotMatch(briefTurnReply(['graph'], ['graph']), /指标/);
  assert.match(briefTurnReply(['metrics'], ['metrics']), /指标白板已生成/);
});
