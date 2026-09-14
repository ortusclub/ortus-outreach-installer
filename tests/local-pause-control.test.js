import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestLocalPause, releaseLocalPause } from '../src/local-pause-control.js';
import { pausePrimaryTasksForOwner } from '../src/primary-task-control.js';
import { saveTasks, loadTasks, selectDue, pauseTaskOwner, resumeTaskOwner, stopTaskOwner, isTaskOwnerSuspended } from '../src/primary-tasks.js';

const owner = { campaignId: 'pause-fixture', campaignRunId: 'run' };
test('Pause preserves future tasks, survives reload, and Stop defeats an older Resume', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-pause-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([{ ...owner, id: 'one', type: 'follow-up', status: 'pending', dueAt: 0 }], file);
  const receipt = requestLocalPause({ owner, controller: new AbortController(), hold: async () => {}, drained: async () => true }, {
    pause: o => pausePrimaryTasksForOwner(o, { file }),
  });
  await receipt.done;
  assert.equal(receipt.confirmed, true);
  assert.equal((await loadTasks(file))[0].status, 'pending');
  assert.deepEqual(selectDue(await loadTasks(file), Date.now()), []);
  assert.equal(await isTaskOwnerSuspended(owner, file), true);
  assert.equal(await releaseLocalPause(receipt, () => true, { resume: (o, id) => resumeTaskOwner(o, id, file) }), true);
  assert.equal(selectDue(await loadTasks(file), Date.now()).length, 1);
  const later = await pauseTaskOwner(owner, file);
  await stopTaskOwner(owner, file);
  assert.equal((await loadTasks(file)).filter(t => t.type === 'owner-control').length, 1);
  assert.equal(await resumeTaskOwner(owner, later.commandId, file), false);
  assert.equal((await loadTasks(file))[0].status, 'cancelled');
});

test('browser interruption is immediate but Resume waits for closure and foreground settlement', async () => {
  const controller = new AbortController();
  let close, settle;
  const closed = new Promise(resolve => { close = resolve; });
  const settled = new Promise(resolve => { settle = resolve; });
  const receipt = requestLocalPause({ owner, controller, hold: async () => {}, drained: () => settled }, {
    pause: () => closed,
  });
  assert.equal(controller.signal.aborted, true);
  assert.equal(await releaseLocalPause(receipt, () => true), false);
  close({ stopped: true, commandId: 'one' });
  await Promise.resolve();
  assert.equal(receipt.confirmed, false);
  settle(true); await receipt.done;
  assert.equal(receipt.confirmed, true);
  assert.equal(await releaseLocalPause(receipt, () => false), false);
});

for (const failure of ['close', 'persist', 'foreground']) {
  test(`${failure} failure keeps Pause unconfirmed and Resume blocked`, async () => {
    const receipt = requestLocalPause({ owner, controller: new AbortController(),
      hold: async () => { if (failure === 'persist') throw new Error('fixture disk failure'); },
      drained: async () => failure !== 'foreground',
    }, { pause: async () => ({ stopped: failure !== 'close', commandId: 'one' }) });
    await receipt.done;
    assert.equal(receipt.confirmed, false);
    assert.equal(await releaseLocalPause(receipt, () => true), false);
  });
}
