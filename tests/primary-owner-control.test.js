import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTaskOwner, taskOwnerOf } from '../src/task-owner.js';
import { extractMonitoringSlice } from '../src/monitoring-persistence.js';
import { saveTasks, loadTasks, enqueuePrimaryTask, claimTask, markTask, selectDue, stopTaskOwner, resetInProgress, isTaskOwnerStopped } from '../src/primary-tasks.js';
import { stopPrimaryTasksForOwner, registerPrimaryOperation } from '../src/primary-task-control.js';
import { runDueTasks } from '../src/primary-task-runner.js';

const owner = { campaignId: 'fixture-campaign', campaignRunId: 'fixture-run' };
const task = (id, extra = {}) => ({ id, ...owner, type: 'follow-up', status: 'pending',
  dueAt: 1, sender: 'local-browser', body: 'fixture', threadUrl: id, ...extra });
async function fileFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-owner-control-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'tasks.json');
}
test('fresh runs get new identity; explicit restore and monitoring persistence retain it', () => {
  const first = startTaskOwner();
  assert.notEqual(startTaskOwner(first).campaignRunId, first.campaignRunId);
  assert.deepEqual(startTaskOwner({ ...first, resumeTaskRun: true }), first);
  const slice = extractMonitoringSlice({ taskCampaignId: first.campaignId, campaignRunId: first.campaignRunId, state: 'monitoring' });
  assert.deepEqual(taskOwnerOf(slice), first);
  assert.equal(taskOwnerOf({ id: 'legacy-singleton' }), null);
});
test('Stop blocks late enqueue and claims without adopting another run', async t => {
  const file = await fileFor(t);
  await saveTasks([task('pending'), task('other', { campaignRunId: 'other' })], file);
  await stopTaskOwner(owner, file);
  assert.equal(await isTaskOwnerStopped(owner, file), true);
  assert.equal(await isTaskOwnerStopped({ ...owner, campaignRunId: 'other' }, file), false);
  const late = task('late');
  await enqueuePrimaryTask(late, file);
  assert.equal(await claimTask(late, 10, file), false);
  assert.deepEqual(selectDue(await loadTasks(file), 10).map(t => t.id), ['other']);
});
test('Stop interrupts current owned task; next campaign remains pending', async t => {
  const file = await fileFor(t);
  await saveTasks([task('current'), task('other', { campaignRunId: 'other' })], file);
  let entered, interrupt;
  const entering = new Promise(resolve => { entered = resolve; });
  const action = new Promise((_resolve, reject) => { interrupt = reject; });
  const runner = runDueTasks(10, {
    loadTasks: () => loadTasks(file),
    markTask: (id, status, patch) => markTask(id, status, patch, file),
    claimTask: (snapshot, now) => claimTask(snapshot, now, file),
    launchLocal: async () => ({ page: {} }), closeLocal: async () => { interrupt(new Error('closed by fixture Stop')); return { browserClosed: true }; },
    launchAccount: async () => { throw new Error('unexpected launch'); }, closeAccount: async () => {},
    checkSignedOut: async () => false,
    sendInThread: async () => { entered(); return action; },
    semaphore: { acquire: async () => {}, release() {} }, log() {},
  });
  await entering;
  const stopped = await stopPrimaryTasksForOwner(owner, { file });
  await runner;
  assert.equal(stopped.stopped, true);
  const tasks = await loadTasks(file);
  assert.equal(tasks.find(t => t.id === 'current').status, 'interrupted');
  assert.equal(tasks.find(t => t.id === 'other').status, 'pending');
});
test('unresponsive active task remains unconfirmed and unrelated operation is not closed', async t => {
  const file = await fileFor(t);
  await saveTasks([], file);
  let otherClosed = false;
  let responsive = false;
  const active = registerPrimaryOperation(owner, () => responsive ? { browserClosed: true } : new Promise(() => {}));
  const other = registerPrimaryOperation({ ...owner, campaignRunId: 'other' }, () => { otherClosed = true; });
  try {
    const result = await stopPrimaryTasksForOwner(owner, { file, timeoutMs: 10 });
    assert.equal(result.stopped, false);
    assert.equal(active.signal.aborted, true);
    assert.equal(other.signal.aborted, false);
    assert.equal(otherClosed, false);
  } finally {
    responsive = true;
    active.finish(); other.finish();
    await stopPrimaryTasksForOwner(owner, { file, timeoutMs: 10 });
  }
});
test('crash recovery does not requeue an in-progress task from a stopped run', async t => {
  const file = await fileFor(t);
  await saveTasks([task('uncertain', { status: 'in_progress' })], file);
  const result = await stopPrimaryTasksForOwner(owner, { file });
  assert.equal(result.stopped, false);
  await resetInProgress(file);
  assert.equal((await loadTasks(file)).find(t => t.id === 'uncertain').status, 'interrupted');
  assert.equal(selectDue(await loadTasks(file), 10).length, 0);
});
