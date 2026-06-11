import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRun, runDueTasks } from '../src/primary-task-runner.js';

test('shouldRun only when no campaign and no browser open', () => {
  assert.equal(shouldRun({ campaignRunning: false, browserCount: 0 }), true);
  assert.equal(shouldRun({ campaignRunning: true, browserCount: 0 }), false);
  assert.equal(shouldRun({ campaignRunning: false, browserCount: 1 }), false);
});

function fakeSemaphore() {
  const calls = { acquire: 0, release: 0 };
  return { calls, async acquire() { calls.acquire++; }, release() { calls.release++; }, getStatus() { return { count: 0, max: 2 }; } };
}

test('runDueTasks accepts the matching invite and marks it done', async () => {
  const marks = [];
  const tasks = [{ id: 'a1', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Pat' }, attempts: 0 }];
  const sem = fakeSemaphore();
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => { marks.push([id, status]); },
    launchLocal: async () => ({ browser: {}, page: { _local: true } }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true, reason: 'name' }),
    sendInThread: async () => {},
    semaphore: sem,
    log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(marks, [['a1', 'done']]);
  assert.equal(sem.calls.acquire, 1);
  assert.equal(sem.calls.release, 1);
});

test('runDueTasks sends a campaign-account follow-up via launchAccount', async () => {
  const marks = [];
  const opened = [];
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'p9', status: 'pending', dueAt: 1, threadUrl: 'https://www.linkedin.com/messaging/thread/x', body: 'hi', attempts: 0 }];
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => marks.push([id, status]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async (pid) => { opened.push(pid); return { page: {} }; },
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => {},
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(opened, ['p9']);
  assert.deepEqual(marks, [['f1', 'done']]);
});

test('runDueTasks retries (stays pending) up to 3 attempts then fails', async () => {
  const marks = [];
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'local-browser', status: 'pending', dueAt: 1, threadUrl: 't', body: 'hi', attempts: 2 }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status, patch) => marks.push([id, status, patch.attempts]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => { throw new Error('not logged in'); },
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.deepEqual(marks, [['f1', 'failed', 3]]);
});

test('runDueTasks does nothing when no tasks are due', async () => {
  const res = await runDueTasks(10, {
    loadTasks: async () => [{ id: 'x', type: 'accept', status: 'pending', dueAt: 999 }],
    markTask: async () => { throw new Error('should not mark'); },
    launchLocal: async () => { throw new Error('should not launch'); },
    closeLocal: async () => {}, launchAccount: async () => ({}), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({}), sendInThread: async () => {},
    semaphore: fakeSemaphore(), log: () => {},
  });
  assert.equal(res.ran, 0);
});
