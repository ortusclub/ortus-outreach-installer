import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTasks, loadTasks, claimTask, cancelTasksForOwner, markTask,
  enqueuePrimaryTask, buildAcceptTask, buildFollowUpTask, dedupeKey } from '../src/primary-tasks.js';

const owner = { campaignId: 'campaign-a', campaignRunId: 'run-a' };
const pending = () => ({ id: 'fixture-a', type: 'follow-up', ...owner,
  campaignProfileId: 'shared-account', status: 'pending', dueAt: 1, body: 'fixture', leadUrl: 'fixture-lead' });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-task-transaction-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  return file;
}

test('cancellation before claim prevents the claim; another run and legacy tasks stay untouched', async t => {
  const file = await fixture(t), task = pending();
  await saveTasks([task, { ...task, id: 'other', campaignRunId: 'run-b' },
    { ...task, id: 'legacy', campaignRunId: '' }], file);
  const cancel = cancelTasksForOwner(owner, file);
  const claim = claimTask(task, 10, file);
  assert.equal(await cancel, 1);
  assert.equal(await claim, false);
  assert.deepEqual((await loadTasks(file)).map(t => t.status), ['cancelled', 'pending', 'pending']);
});

test('claim before cancellation remains in progress, not falsely reported cancelled', async t => {
  const file = await fixture(t), task = pending();
  await saveTasks([task], file);
  const claim = claimTask(task, 10, file);
  const cancel = cancelTasksForOwner(owner, file);
  assert.equal(await claim, true);
  assert.equal(await cancel, 0);
  assert.equal((await loadTasks(file))[0].status, 'in_progress');
});

test('simultaneous claims authorize only one runner', async t => {
  const file = await fixture(t), task = pending();
  await saveTasks([task], file);
  const results = await Promise.all([claimTask(task, 10, file), claimTask(task, 10, file)]);
  assert.deepEqual(results, [true, false]);
});

test('parallel enqueues preserve both records', async t => {
  const file = await fixture(t), task = pending();
  await Promise.all([enqueuePrimaryTask(task, file),
    enqueuePrimaryTask({ ...task, id: 'other', leadUrl: 'other-lead' }, file)]);
  assert.equal((await loadTasks(file)).length, 2);
});

test('a stale retry mark cannot revive a cancelled task', async t => {
  const file = await fixture(t), task = pending();
  await saveTasks([task], file);
  await cancelTasksForOwner(owner, file);
  assert.equal(await markTask(task.id, 'pending', {}, file), false);
  assert.equal((await loadTasks(file))[0].status, 'cancelled');
});

test('mutation refuses corrupt queue contents without overwriting them', async t => {
  const file = await fixture(t);
  await writeFile(file, 'broken-json');
  await assert.rejects(claimTask(pending(), 10, file));
  assert.equal(await readFile(file, 'utf8'), 'broken-json');
});

test('builders preserve explicit ownership and dedupe does not merge different runs', () => {
  const a = buildAcceptTask({ ...owner, campaignProfileId: 'shared', now: 1 });
  const b = buildAcceptTask({ ...owner, campaignRunId: 'run-b', campaignProfileId: 'shared', now: 2 });
  assert.equal(a.campaignRunId, 'run-a');
  assert.notEqual(dedupeKey(a), dedupeKey(b));
  assert.equal(buildFollowUpTask({ ...owner, campaignProfileId: 'shared' }).campaignRunId, 'run-a');
  assert.throws(() => cancelTasksForOwner({ campaignId: 'campaign-a' }), /Exact campaign/);
});
