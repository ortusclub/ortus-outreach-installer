import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopCloudWithLocalTasks, resumeCloudWithLocalTasks, withLocalCloudControl } from '../src/cloud-campaign-control.js';
import { saveTasks, loadTasks, selectDue, enqueuePrimaryTask, claimTask, markTask, cloudTaskControl, controlCloudTaskOwner } from '../src/primary-tasks.js';
import { runDueTasks } from '../src/primary-task-runner.js';

const task = (id, campaignId = 'cloud') => ({ id, sourceTaskId: id, campaignId, campaignRunId: 'run',
  type: 'follow-up', status: 'pending', dueAt: 1, body: 'fixture', threadUrl: id, leadUrl: id });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-cloud-control-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([task('mine'), task('other', 'other')], file);
  return file;
}
const vmStop = async () => ({ ok: true, status: 'cancelled' });

test('Stop persists before late handoff and leaves unrelated campaign unchanged', async t => {
  const file = await fixture(t);
  assert.equal((await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop })).ok, true);
  await enqueuePrimaryTask(task('late'), file);
  assert.deepEqual((await loadTasks(file)).filter(t => t.sourceTaskId).map(t => t.status), ['cancelled', 'pending', 'cancelled']);
});

test('Pause preserves future work through reload and explicit Resume releases it', async t => {
  const file = await fixture(t);
  await stopCloudWithLocalTasks('cloud', { pause: true }, { file, stopRemote: async () => ({ ok: true, status: 'paused' }) });
  await enqueuePrimaryTask(task('late'), file);
  assert.deepEqual(selectDue(await loadTasks(file), 10).map(t => t.id), ['other']);
  assert.equal((await loadTasks(file)).find(t => t.id === 'mine').status, 'pending');
  const result = await resumeCloudWithLocalTasks('cloud', { file, resumeRemote: async () => ({ ok: true, status: 'running' }) });
  assert.equal(result.delegatedResumed, true);
  assert.equal(selectDue(await loadTasks(file), 10).length, 3);
});

test('a newer Stop cannot be undone by an older Resume response', async t => {
  const file = await fixture(t);
  await stopCloudWithLocalTasks('cloud', { pause: true }, { file, stopRemote: vmStop });
  const result = await resumeCloudWithLocalTasks('cloud', { file, resumeRemote: async () => {
    await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop });
    return { ok: true, status: 'running' };
  } });
  assert.equal(result.conflict, true);
  assert.equal((await cloudTaskControl('cloud', file)).status, 'stopped');
});

test('Resume reconciles an empty local Stop marker only when the VM is paused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-cloud-pause-reconcile-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([], file);
  await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop });
  let resumed = 0;
  const result = await resumeCloudWithLocalTasks('cloud', {
    file,
    getRemote: async () => ({ campaign: { id: 'cloud', status: 'paused' } }),
    resumeRemote: async () => { resumed++; return { ok: true, status: 'running' }; },
  });
  assert.equal(result.delegatedResumed, true);
  assert.equal(resumed, 1);
  assert.equal(await cloudTaskControl('cloud', file), null);
});

test('Resume does not clear a Stop marker that cancelled delegated work', async t => {
  const file = await fixture(t);
  await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop });
  let resumed = 0;
  const result = await resumeCloudWithLocalTasks('cloud', {
    file,
    getRemote: async () => ({ campaign: { id: 'cloud', status: 'paused' } }),
    resumeRemote: async () => { resumed++; return { ok: true, status: 'running' }; },
  });
  assert.equal(result.conflict, true);
  assert.equal(resumed, 0);
  assert.equal((await cloudTaskControl('cloud', file)).status, 'stopped');
});

test('Resume does not clear a Stop marker when the VM is not paused', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-cloud-pause-reconcile-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([], file);
  await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop });
  const result = await resumeCloudWithLocalTasks('cloud', {
    file,
    getRemote: async () => ({ campaign: { id: 'cloud', status: 'cancelled' } }),
    resumeRemote: async () => { throw new Error('must not resume'); },
  });
  assert.equal(result.conflict, true);
  assert.equal((await cloudTaskControl('cloud', file)).status, 'stopped');
});

test('VM failure does not roll back local Stop protection', async t => {
  const file = await fixture(t);
  const result = await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: async () => { throw new Error('offline'); } });
  assert.equal(result.ok, false);
  assert.equal(result.stopping, true);
  assert.equal(result.delegated.stopped, true);
  assert.equal((await loadTasks(file))[0].status, 'cancelled');
  const snapshot = { campaign: { id: 'cloud', status: 'cancelled' } };
  const displayed = await withLocalCloudControl(snapshot, file);
  assert.equal(displayed.campaign.status, 'stopping');
  assert.equal(displayed.campaign.vmStatus, 'cancelled');
  assert.equal(snapshot.campaign.status, 'cancelled', 'do not mutate the remote cache');
});

test('durable VM Stop awaiting browser proof remains pending without claiming success', async t => {
  const file = await fixture(t);
  const result = await stopCloudWithLocalTasks('cloud', {}, { file,
    stopRemote: async () => ({ ok: false, pending: true, status: 'stopping', commandId: 'stop-1',
      pendingReason: 'Browser shutdown receipt pending' }),
  });
  assert.equal(result.pending, true);
  assert.equal(result.stopping, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, undefined);
  assert.equal((await loadTasks(file))[0].status, 'cancelled');
});

test('late VM cancellation settles an empty local Stop marker during normal reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-cloud-stop-late-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([], file);
  await controlCloudTaskOwner('cloud', {}, file);
  const snapshot = { campaign: { id: 'cloud', status: 'cancelled' } };
  const displayed = await withLocalCloudControl(snapshot, file);
  assert.equal(displayed.campaign.status, 'cancelled');
  assert.equal((await cloudTaskControl('cloud', file)).shutdownConfirmed, true);
  const board = await withLocalCloudControl({ campaigns: [{ id: 'cloud', status: 'cancelled' }] }, file);
  assert.equal(board.campaigns[0].status, 'cancelled');
});

test('late VM cancellation does not settle a marker protecting delegated tasks', async t => {
  const file = await fixture(t);
  await controlCloudTaskOwner('cloud', {}, file);
  const displayed = await withLocalCloudControl({ campaign: { id: 'cloud', status: 'cancelled' } }, file);
  assert.equal(displayed.campaign.status, 'stopping');
  assert.equal((await cloudTaskControl('cloud', file)).shutdownConfirmed, false);
});

test('keep-monitoring preserves delegated follow-ups', async t => {
  const file = await fixture(t);
  await stopCloudWithLocalTasks('cloud', { keepMonitoring: true }, { file, stopRemote: async () => ({ ok: true, status: 'monitoring' }) });
  assert.equal(selectDue(await loadTasks(file), 10).length, 2);
});

test('cloud Stop interrupts a delegated action and preserves its uncertain outcome', async t => {
  const file = await fixture(t);
  let entered, reject;
  const entering = new Promise(resolve => { entered = resolve; });
  const action = new Promise((_resolve, fail) => { reject = fail; });
  const running = runDueTasks(10, {
    loadTasks: () => loadTasks(file), claimTask: (task, now) => claimTask(task, now, file),
    markTask: (id, status, patch) => markTask(id, status, patch, file),
    launchLocal: async () => ({ page: {} }), closeLocal: async () => { reject(new Error('fixture interruption')); return { browserClosed: true }; },
    checkSignedOut: async () => false, sendInThread: async () => { entered(); return action; },
    semaphore: { acquire: async () => {}, release() {} }, log() {},
  });
  await entering;
  const result = await stopCloudWithLocalTasks('cloud', {}, { file, stopRemote: vmStop });
  await running;
  assert.equal(result.ok, true);
  assert.equal((await loadTasks(file))[0].status, 'interrupted');
  assert.equal((await loadTasks(file))[1].status, 'pending');
});

test('Stop during unresolved launch stays unconfirmed; late browser never sends', async t => {
  const file = await fixture(t);
  let resolveLaunch, entered;
  const entering = new Promise(resolve => { entered = resolve; });
  let closed = 0, sent = 0;
  const running = runDueTasks(10, {
    loadTasks: () => loadTasks(file), claimTask: (task, now) => claimTask(task, now, file),
    markTask: (id, status, patch) => markTask(id, status, patch, file),
    launchLocal: () => { entered(); return new Promise(resolve => { resolveLaunch = resolve; }); },
    closeLocal: async () => { closed++; return { browserClosed: true }; }, checkSignedOut: async () => false,
    sendInThread: async () => { sent++; }, semaphore: { acquire: async () => {}, release() {} }, log() {},
  });
  await entering;
  const result = await stopCloudWithLocalTasks('cloud', {}, { file, timeoutMs: 10, stopRemote: vmStop });
  assert.equal(result.ok, false);
  resolveLaunch({ page: {} });
  await running;
  assert.equal(sent, 0);
  assert.equal(closed, 1);
  assert.equal((await loadTasks(file)).find(t => t.id === 'other').attempts, undefined);
});
