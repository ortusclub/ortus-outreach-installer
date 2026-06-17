import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  slideFollowUpDueDates, summarizeFollowUps,
  enqueueFollowUpBatched, loadTasks, saveTasks, buildFollowUpTask,
} from '../src/primary-tasks.js';

function tmpFile() { return join(mkdtempSync(join(tmpdir(), 'fu-')), 'primary-tasks.json'); }

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

test('enqueueFollowUpBatched aligns the new task + existing siblings to now+delay', async () => {
  const file = tmpFile();
  const now = 1_000_000;
  await saveTasks([
    { id:'old', type:'follow-up', status:'pending', campaignProfileId:'p1', leadUrl:'x', dueAt: now - 50_000, sender:'local-browser' },
  ], file);
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'y', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 10, now, file);
  const all = await loadTasks(file);
  const expected = now + 10 * 60_000;
  assert.equal(stored.dueAt, expected);
  assert.deepEqual(all.map(t => t.dueAt).sort((a,b)=>a-b), [expected, expected]);
});

test('enqueueFollowUpBatched returns null on a duplicate lead but still slides siblings', async () => {
  const file = tmpFile();
  const now = 2_000_000;
  await saveTasks([
    { id:'dup', type:'follow-up', status:'pending', campaignProfileId:'p1', leadUrl:'y', dueAt: now - 99_000, sender:'local-browser' },
  ], file);
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'y', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 10, now, file);
  const all = await loadTasks(file);
  assert.equal(stored, null);
  assert.equal(all.length, 1);
  assert.equal(all[0].dueAt, now + 10 * 60_000);
});

test('enqueueFollowUpBatched defaults to 10 minutes for an invalid delay', async () => {
  const file = tmpFile();
  const now = 3_000_000;
  const task = buildFollowUpTask({ campaignProfileId:'p1', leadUrl:'z', sender:'local-browser', now });
  const stored = await enqueueFollowUpBatched(task, 0, now, file);
  assert.equal(stored.dueAt, now + 10 * 60_000);
});
