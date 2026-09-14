import test from 'node:test';
import assert from 'node:assert/strict';
import { runDueTasks } from '../src/primary-task-runner.js';

function fixture(sender = 'local-browser') {
  const state = { tasks: [
    { id: 'a', type: 'follow-up', campaignId: 'campaign-a', campaignRunId: 'run-a', sender,
      status: 'pending', dueAt: 1, body: 'first', threadUrl: 'fixture-a', attempts: 0 },
    { id: 'b', type: 'follow-up', campaignId: 'campaign-b', campaignRunId: 'run-b', sender,
      status: 'pending', dueAt: 1, body: 'second', threadUrl: 'fixture-b', attempts: 0 },
  ], sent: [], marked: [], closed: 0, released: 0 };
  const deps = {
    loadTasks: async () => structuredClone(state.tasks),
    markTask: async (id, status, patch = {}) => {
      const task = state.tasks.find(t => t.id === id);
      if (!task) return false;
      state.marked.push([id, status]);
      Object.assign(task, patch, { status });
      return true;
    },
    launchLocal: async () => ({ page: {} }), launchAccount: async () => ({ page: {} }),
    closeLocal: async () => state.closed++, closeAccount: async () => state.closed++,
    semaphore: { acquire: async () => {}, release: () => state.released++ },
    checkSignedOut: async () => false,
    sendInThread: async (_page, thread) => state.sent.push(thread),
    acceptInvitationFrom: async () => ({ accepted: true }), log: () => {},
  };
  return { state, deps };
}

for (const sender of ['local-browser', 'fixture-account']) {
  test(`cancel during ${sender} launch skips only the cancelled campaign's task`, async () => {
    const { state, deps } = fixture(sender);
    const launch = async () => { state.tasks[0].status = 'cancelled'; return { page: {} }; };
    deps.launchLocal = launch; deps.launchAccount = launch;
    const result = await runDueTasks(10, deps);
    assert.equal(result.ran, 1);
    assert.deepEqual(state.sent, ['fixture-b']);
    assert.equal(state.tasks[0].status, 'cancelled');
    assert.equal(state.closed, 1);
    assert.equal(state.released, 1);
  });
}

test('a removed task is not resurrected from a loaded batch', async () => {
  const { state, deps } = fixture();
  deps.launchLocal = async () => { state.tasks.shift(); return { page: {} }; };
  await runDueTasks(10, deps);
  assert.deepEqual(state.sent, ['fixture-b']);
  assert.ok(!state.marked.some(([id]) => id === 'a'));
});

test('launch failure does not turn a cancelled task back into a retry', async () => {
  const { state, deps } = fixture();
  deps.launchLocal = async () => { state.tasks[0].status = 'cancelled'; throw new Error('fixture launch failed'); };
  await runDueTasks(10, deps);
  assert.equal(state.tasks[0].status, 'cancelled');
  assert.ok(!state.marked.some(([id]) => id === 'a'));
  assert.equal(state.tasks[1].attempts, 1);
});

test('an edited task is deferred rather than sending the stale body', async () => {
  const { state, deps } = fixture();
  deps.launchLocal = async () => { state.tasks[0].body = 'edited'; return { page: {} }; };
  await runDueTasks(10, deps);
  assert.deepEqual(state.sent, ['fixture-b']);
  assert.equal(state.tasks[0].status, 'pending');
  assert.equal(state.tasks[0].body, 'edited');
});

test('failed claim never authorizes a send', async () => {
  const { state, deps } = fixture();
  deps.markTask = async () => false;
  const result = await runDueTasks(10, deps);
  assert.equal(result.ran, 0);
  assert.deepEqual(state.sent, []);
});

test('cancellation during a failed action is not overwritten by retry handling', async () => {
  const { state, deps } = fixture();
  deps.sendInThread = async (_page, thread) => {
    if (thread === 'fixture-a') { state.tasks[0].status = 'cancelled'; throw new Error('interrupted'); }
    state.sent.push(thread);
  };
  await runDueTasks(10, deps);
  assert.equal(state.tasks[0].status, 'cancelled');
  assert.deepEqual(state.sent, ['fixture-b']);
});
