import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTasks, loadTasks, selectDue, claimTask, markTask, resetInProgress,
  holdTasksWithoutOwner, enqueuePrimaryTask, enqueueFollowUpBatched } from '../src/primary-tasks.js';
import { runDueTasks } from '../src/primary-task-runner.js';
import { countFollowUpHealth } from '../src/followup-groups.js';

const task = (extra = {}) => ({ id: 'legacy', type: 'follow-up', status: 'pending',
  dueAt: 1, campaignProfileId: 'shared', body: 'preserve this', ...extra });
const owned = (extra = {}) => task({ id: 'owned', campaignId: 'campaign', campaignRunId: 'run', ...extra });
test('health distinguishes ownership review, unknown outcomes and reply holds', () => {
  const health = countFollowUpHealth([
    task({ status: 'needs-review' }), owned({ status: 'interrupted' }),
    owned({ status: 'held' }), owned(),
  ]);
  assert.equal(health.needsReview, 1);
  assert.equal(health.interrupted, 1);
  assert.equal(health.held, 1);
  assert.equal(health.pending, 1);
  assert.equal(health.failed, 0);
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-task-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'tasks.json');
}

test('legacy selection and direct stale claims cannot authorize work before migration', async t => {
  const file = await fixture(t);
  for (const partial of [{}, { campaignId: 'campaign' }, { campaignRunId: 'run' },
    { campaignId: ' ', campaignRunId: 'run' }]) {
    const legacy = task(partial);
    await saveTasks([legacy], file);
    assert.deepEqual(selectDue([legacy], 10), []);
    assert.equal(await claimTask(legacy, 10, file), false);
    const [stored] = await loadTasks(file);
    assert.equal(stored.status, 'needs-review');
    assert.equal(stored.body, legacy.body);
    assert.equal(stored.reviewReason, 'campaign-ownership-unproven');
  }
});

test('holding is idempotent and preserves terminal tasks, reply holds and owner markers', async t => {
  const file = await fixture(t);
  const untouched = ['done', 'failed', 'cancelled', 'discarded', 'held'].map(status => task({ id: status, status }));
  const marker = { id: 'marker', type: 'owner-control', status: 'stopped' };
  await saveTasks([task(), task({ id: 'active', status: 'in_progress' }), owned(), ...untouched, marker], file);
  assert.equal(await holdTasksWithoutOwner(file), 2);
  assert.equal(await holdTasksWithoutOwner(file), 0);
  const stored = await loadTasks(file);
  assert.equal(stored[1].reviewPreviousStatus, 'in_progress');
  assert.deepEqual(stored.slice(2), [owned(), ...untouched, marker]);
});

test('new unowned work is preserved for review without shifting another run’s batch', async t => {
  const file = await fixture(t);
  await saveTasks([owned()], file);
  assert.equal(await enqueuePrimaryTask(task(), file), null);
  assert.equal(await enqueueFollowUpBatched(task({ id: 'batch' }), 10, 20, file), null);
  const stored = await loadTasks(file);
  assert.deepEqual(stored[0], owned());
  assert.deepEqual(stored.slice(1).map(t => t.status), ['needs-review', 'needs-review']);
  assert.equal(await markTask('legacy', 'pending', {}, file), false);
});

test('restart preserves unknown outcomes instead of automatically repeating them', async t => {
  const file = await fixture(t);
  await saveTasks([owned({ status: 'in_progress' }), task({ status: 'in_progress' })], file);
  assert.equal(await resetInProgress(file), true);
  assert.equal(await resetInProgress(file), false);
  const stored = await loadTasks(file);
  assert.equal(stored[0].status, 'interrupted');
  assert.equal(stored[0].reviewReason, 'action-outcome-unknown');
  assert.equal(stored[1].status, 'needs-review');
  assert.equal(await markTask('owned', 'pending', {}, file), false);
  assert.equal(await markTask('owned', 'failed', {}, file), false);
  assert.equal(await markTask('legacy', 'failed', {}, file), false);
  assert.deepEqual(selectDue(stored, 10), []);
});

test('runner never opens a browser for an unowned task', async () => {
  const result = await runDueTasks(10, {
    loadTasks: async () => [task()],
    launchLocal: async () => assert.fail('must not launch'),
    launchAccount: async () => assert.fail('must not launch'),
  });
  assert.equal(result.ran, 0);
});

test('ownership removed during browser launch invalidates the loaded batch', async () => {
  const tasks = [owned()];
  let closed = 0;
  const result = await runDueTasks(10, {
    loadTasks: async () => tasks,
    launchLocal: async () => { delete tasks[0].campaignRunId; return { page: {} }; },
    closeLocal: async () => closed++,
    checkSignedOut: async () => false,
    sendInThread: async () => assert.fail('must not send'),
    markTask: async () => assert.fail('must not claim'),
    semaphore: { acquire: async () => {}, release() {} }, log() {},
  });
  assert.equal(result.ran, 0);
  assert.equal(closed, 1);
});
