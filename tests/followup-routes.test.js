import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadTasks, saveTasks } from '../src/primary-tasks.js';
import { belongsToCampaign, groupStaleFollowUps, discardGroups, restoreDiscarded } from '../src/followup-groups.js';

// The routes are four thin wrappers over followup-groups.js plus the task file.
// What is worth pinning here is the round trip through disk: discard must
// SURVIVE a save/load, or an operator's decision is undone by the next restart.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ortus-fu-'));
const FILE = path.join(dir, 'primary-tasks.json');

const fu = (o) => ({
  type: 'follow-up', status: 'pending', attempts: 0, lastError: null,
  createdAt: 1_700_000_000_000, dueAt: 1_700_000_000_000, ...o,
});

test('discard survives a save and reload', async () => {
  const tasks = [
    fu({ id: 'a', campaignId: 'OLD', status: 'failed', body: 'Hi Michael, dinner on 4 September.', leadName: 'Michael' }),
    fu({ id: 'b', campaignId: 'KEEP', status: 'failed', body: 'Hi Nancy, roundtable on 26 August.', leadName: 'Nancy' }),
  ];
  await saveTasks(tasks, FILE);

  const groups = groupStaleFollowUps(await loadTasks(FILE));
  const target = groups.find((g) => g.campaignId === 'OLD');
  const { tasks: after, discarded } = discardGroups(await loadTasks(FILE), [target.key]);
  await saveTasks(after, FILE);

  const reloaded = await loadTasks(FILE);
  assert.equal(reloaded.find((t) => t.id === 'a').status, 'discarded');
  assert.equal(reloaded.find((t) => t.id === 'b').status, 'failed', 'the other campaign is untouched');
  assert.deepEqual(groupStaleFollowUps(reloaded).map((g) => g.campaignId), ['KEEP']);

  // …and Undo puts it back, also across disk.
  await saveTasks(restoreDiscarded(reloaded, discarded), FILE);
  const undone = await loadTasks(FILE);
  assert.equal(undone.find((t) => t.id === 'a').status, 'failed');
  assert.equal(groupStaleFollowUps(undone).length, 2);
});

test('the card scope matches by campaignId first and by account only as a fallback', () => {
  const stamped = fu({ campaignId: 'A', campaignProfileId: 'p9' });
  // A stamped task belongs to its campaign even when the account is shared with
  // another live campaign — the id is the stronger fact.
  assert.equal(belongsToCampaign(stamped, { campaignId: 'A', profileIds: [] }), true);
  assert.equal(belongsToCampaign(stamped, { campaignId: 'B', profileIds: ['p9'] }), false);
  const legacy = fu({ campaignProfileId: 'p9' });
  assert.equal(belongsToCampaign(legacy, { campaignId: 'B', profileIds: ['p9'] }), true);
});

test('an accept task is never counted as a follow-up', () => {
  const accept = { type: 'accept', status: 'failed', campaignProfileId: 'p1', id: 'z' };
  assert.equal(belongsToCampaign(accept, { profileIds: ['p1'] }), false);
  assert.equal(groupStaleFollowUps([accept]).length, 0);
});
