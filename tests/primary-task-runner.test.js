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

// Terminal marks = everything except the 'in_progress' claim written before each action.
const terminal = (marks) => marks.filter(m => m[1] !== 'in_progress');

test('runDueTasks claims in_progress, accepts the matching invite, marks it done', async () => {
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
  assert.ok(marks.some(m => m[0] === 'a1' && m[1] === 'in_progress'), 'claims in_progress first');
  assert.deepEqual(terminal(marks), [['a1', 'done']]);
  assert.equal(sem.calls.acquire, 1);
  assert.equal(sem.calls.release, 1);
});

test('runDueTasks marks an unmatched accept as skipped', async () => {
  const marks = [];
  const tasks = [{ id: 'a1', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Pat' }, attempts: 0 }];
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => marks.push([id, status]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: false, reason: 'no-match' }),
    sendInThread: async () => {},
    semaphore: fakeSemaphore(), log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(terminal(marks), [['a1', 'skipped']]);
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
  assert.deepEqual(terminal(marks), [['f1', 'done']]);
});

test('runDueTasks retries (stays pending) up to 3 attempts then fails', async () => {
  const marks = [];
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'local-browser', status: 'pending', dueAt: 1, threadUrl: 't', body: 'hi', attempts: 2 }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status, patch) => marks.push([id, status, patch?.attempts]),
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => { throw new Error('not logged in'); },
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.deepEqual(terminal(marks), [['f1', 'failed', 3]]);
});

test('a launch failure settles every task in the bucket (caps infinite retry)', async () => {
  const marks = [];
  const tasks = [
    { id: 'a1', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Pat' }, attempts: 0 },
    { id: 'a2', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Sam' }, attempts: 2 },
  ];
  const sem = fakeSemaphore();
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status, patch) => marks.push([id, status, patch?.attempts]),
    launchLocal: async () => { throw new Error('Chrome not found'); },
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }), sendInThread: async () => {},
    semaphore: sem, log: () => {},
  });
  // both tasks get an attempts++; a2 (was 2) tips over to failed, a1 stays pending
  assert.deepEqual(marks, [['a1', 'pending', 1], ['a2', 'failed', 3]]);
  assert.equal(sem.calls.acquire, 1);
  assert.equal(sem.calls.release, 1); // released even though launch failed
});

test('a successful send whose terminal mark fails is NOT re-queued (no double-send)', async () => {
  const statuses = [];
  let sends = 0;
  const tasks = [{ id: 'f1', type: 'follow-up', sender: 'local-browser', status: 'pending', dueAt: 1, threadUrl: 't', body: 'hi', attempts: 0 }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => {
      statuses.push(status);
      if (status === 'done') throw new Error('ENOSPC');  // disk dies right after the send
    },
    launchLocal: async () => ({ page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => { sends++; },
    semaphore: fakeSemaphore(), log: () => {},
  });
  assert.equal(sends, 1, 'sent exactly once');
  // The terminal-mark failure must NOT settle it back to pending/failed.
  assert.ok(!statuses.includes('pending') && !statuses.includes('failed'),
    'task left in_progress, not re-queued');
});

test('guardIdle false defers work — no browser opened, nothing marked', async () => {
  const sem = fakeSemaphore();
  let launched = false;
  const res = await runDueTasks(10, {
    loadTasks: async () => [{ id: 'a1', type: 'accept', status: 'pending', dueAt: 1, account: { name: 'Pat' } }],
    markTask: async () => { throw new Error('should not mark'); },
    launchLocal: async () => { launched = true; return { page: {} }; },
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }), closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }), sendInThread: async () => {},
    semaphore: sem, log: () => {},
    guardIdle: async () => false,
  });
  assert.equal(res.ran, 0);
  assert.equal(launched, false);
  assert.equal(sem.calls.acquire, 0);
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

test('a lead who has already replied gets the follow-up HELD, not sent and not failed', async () => {
  const marks = [];
  const patches = {};
  const tasks = [{ id: 'f1', type: 'follow-up', status: 'pending', dueAt: 1, attempts: 0, leadName: 'James Auld', body: 'hi', threadUrl: 'https://x/t' }];
  const sem = fakeSemaphore();
  const res = await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status, patch) => { marks.push([id, status]); patches[status] = patch; },
    launchLocal: async () => ({ browser: {}, page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    // What thread-message returns when the lead has spoken.
    sendInThread: async () => ({ sent: false, held: { reason: 'declined', phrase: "can't make", quote: "sorry I can't make that event" } }),
    semaphore: sem,
    log: () => {},
  });
  assert.equal(res.ran, 1);
  assert.deepEqual(terminal(marks), [['f1', 'held']], 'held, never done and never failed');
  assert.equal(patches.held.heldReason, 'declined');
  assert.match(patches.held.heldQuote, /can't make that event/);
});

test('a normal send still marks done', async () => {
  const marks = [];
  const tasks = [{ id: 'f2', type: 'follow-up', status: 'pending', dueAt: 1, attempts: 0, leadName: 'Nancy', body: 'hi', threadUrl: 'https://x/t' }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => { marks.push([id, status]); },
    launchLocal: async () => ({ browser: {}, page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => ({ sent: true }),
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.deepEqual(terminal(marks), [['f2', 'done']]);
});

test('a sender that returns nothing at all is still treated as sent', async () => {
  // Older stubs (and any caller not yet updated) return undefined. That must
  // keep meaning "sent", not silently become a hold.
  const marks = [];
  const tasks = [{ id: 'f3', type: 'follow-up', status: 'pending', dueAt: 1, attempts: 0, leadName: 'Pat', body: 'hi', threadUrl: 'https://x/t' }];
  await runDueTasks(10, {
    loadTasks: async () => tasks,
    markTask: async (id, status) => { marks.push([id, status]); },
    launchLocal: async () => ({ browser: {}, page: {} }),
    closeLocal: async () => {},
    launchAccount: async () => ({ page: {} }),
    closeAccount: async () => {},
    acceptInvitationFrom: async () => ({ accepted: true }),
    sendInThread: async () => undefined,
    semaphore: fakeSemaphore(),
    log: () => {},
  });
  assert.deepEqual(terminal(marks), [['f3', 'done']]);
});
