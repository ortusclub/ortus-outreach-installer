import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slideFollowUpDueDates, summarizeFollowUps } from '../src/primary-tasks.js';

test('slideFollowUpDueDates bumps pending follow-ups of the target campaign', () => {
  const tasks = [
    { id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'b', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 200 },
  ];
  const out = slideFollowUpDueDates(tasks, 'p1', 999);
  assert.deepEqual(out.map(t => t.dueAt), [999, 999]);
});

test('slideFollowUpDueDates leaves accepts, other campaigns, and non-pending untouched', () => {
  const tasks = [
    { id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'b', type: 'accept',    status: 'pending', campaignProfileId: 'p1', dueAt: 100 },
    { id: 'c', type: 'follow-up', status: 'pending', campaignProfileId: 'p2', dueAt: 100 },
    { id: 'd', type: 'follow-up', status: 'done',    campaignProfileId: 'p1', dueAt: 100 },
  ];
  const out = slideFollowUpDueDates(tasks, 'p1', 999);
  assert.equal(out[0].dueAt, 999);
  assert.equal(out[1].dueAt, 100);
  assert.equal(out[2].dueAt, 100);
  assert.equal(out[3].dueAt, 100);
});

test('slideFollowUpDueDates does not mutate the input array', () => {
  const tasks = [{ id: 'a', type: 'follow-up', status: 'pending', campaignProfileId: 'p1', dueAt: 100 }];
  slideFollowUpDueDates(tasks, 'p1', 999);
  assert.equal(tasks[0].dueAt, 100);
});

test('slideFollowUpDueDates on empty input returns []', () => {
  assert.deepEqual(slideFollowUpDueDates([], 'p1', 999), []);
});

test('summarizeFollowUps returns null when no pending follow-ups', () => {
  assert.equal(summarizeFollowUps([], ['p1']), null);
  assert.equal(summarizeFollowUps([{ id:'a', type:'accept', status:'pending', campaignProfileId:'p1', dueAt:1 }], ['p1']), null);
});

test('summarizeFollowUps reports count, soonest dueAt, and that task sender', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 500, sender: 'local-browser' },
    { id:'b', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 300, sender: 'profile-xyz' },
  ];
  assert.deepEqual(summarizeFollowUps(tasks, ['p1']), { count: 2, dueAt: 300, sender: 'profile-xyz' });
});

test('summarizeFollowUps ignores other campaigns and non-pending', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p2', dueAt: 100, sender:'local-browser' },
    { id:'b', type:'follow-up', status:'done',    campaignProfileId:'p1', dueAt: 100, sender:'local-browser' },
  ];
  assert.equal(summarizeFollowUps(tasks, ['p1']), null);
});

test('summarizeFollowUps counts across multiple accounts', () => {
  const tasks = [
    { id:'a', type:'follow-up', status:'pending', campaignProfileId:'p1', dueAt: 400, sender:'local-browser' },
    { id:'b', type:'follow-up', status:'pending', campaignProfileId:'p2', dueAt: 200, sender:'profile-2' },
  ];
  assert.deepEqual(summarizeFollowUps(tasks, ['p1','p2']), { count: 2, dueAt: 200, sender: 'profile-2' });
});
