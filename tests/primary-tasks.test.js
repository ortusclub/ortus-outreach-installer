import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  buildFollowUpTask, buildAcceptTask, dedupeKey, selectDue, partitionByBrowser,
  loadTasks, saveTasks, enqueuePrimaryTask, markTask, resetInProgress,
} from '../src/primary-tasks.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'ptasks-'));
  return join(dir, 'primary-tasks.json');
}

test('buildFollowUpTask sets type, dueAt, pending status', () => {
  const t = buildFollowUpTask({
    campaignProfileId: 'p1', campaignProfileName: 'patrick.s', sheetId: 's1', sheetUrl: 'u',
    sender: 'local-browser', threadUrl: 'https://www.linkedin.com/messaging/thread/abc',
    introTitle: 'Intro', leadName: 'Jane Doe', leadUrl: 'https://lnkd/in/jane',
    primaryName: 'You', primaryUrl: 'https://lnkd/in/you', body: 'Hi Jane',
    delayMinutes: 10, now: 1_000_000,
  });
  assert.equal(t.type, 'follow-up');
  assert.equal(t.status, 'pending');
  assert.equal(t.attempts, 0);
  assert.equal(t.dueAt, 1_000_000 + 10 * 60_000);
  assert.equal(t.sender, 'local-browser');
  assert.equal(t.body, 'Hi Jane');
});

test('buildAcceptTask is due immediately and carries the account identity', () => {
  const t = buildAcceptTask({
    campaignProfileId: 'p1', campaignProfileName: 'patrick.s', sheetId: 's1', sheetUrl: 'u',
    account: { name: 'Patrick Smith', profileUrl: 'https://lnkd/in/patrick' },
    primaryUrl: 'https://lnkd/in/you', now: 5_000,
  });
  assert.equal(t.type, 'accept');
  assert.equal(t.dueAt, 5_000);
  assert.equal(t.account.name, 'Patrick Smith');
});

test('dedupeKey distinguishes type + profile + lead', () => {
  const f = buildFollowUpTask({ campaignProfileId: 'p1', leadUrl: 'L', now: 0, delayMinutes: 1 });
  const a = buildAcceptTask({ campaignProfileId: 'p1', now: 0 });
  assert.equal(dedupeKey(f), 'follow-up:p1:L');
  assert.equal(dedupeKey(a), 'accept:p1');
  assert.notEqual(dedupeKey(f), dedupeKey(a));
});

test('selectDue returns only pending tasks at or before now', () => {
  const tasks = [
    { id: '1', status: 'pending', dueAt: 100 },
    { id: '2', status: 'pending', dueAt: 300 },
    { id: '3', status: 'done', dueAt: 50 },
  ];
  const due = selectDue(tasks, 200);
  assert.deepEqual(due.map(t => t.id), ['1']);
});

test('partitionByBrowser splits local vs per-account', () => {
  const due = [
    { id: 'a', type: 'accept', sender: undefined },
    { id: 'f1', type: 'follow-up', sender: 'local-browser' },
    { id: 'f2', type: 'follow-up', sender: 'p9' },
    { id: 'f3', type: 'follow-up', sender: 'p9' },
  ];
  const { local, byAccount } = partitionByBrowser(due);
  assert.deepEqual(local.map(t => t.id), ['a', 'f1']);
  assert.deepEqual(byAccount.p9.map(t => t.id), ['f2', 'f3']);
});

test('enqueue → load round-trips and dedupes pending equivalents', async () => {
  const file = tmpFile();
  const t1 = buildAcceptTask({ campaignProfileId: 'p1', now: 1 });
  const stored = await enqueuePrimaryTask(t1, file);
  assert.ok(stored.id);
  const dup = await enqueuePrimaryTask(buildAcceptTask({ campaignProfileId: 'p1', now: 2 }), file);
  assert.equal(dup, null, 'duplicate pending accept for same profile is skipped');
  const all = await loadTasks(file);
  assert.equal(all.length, 1);
  rmSync(file, { force: true });
});

test('markTask updates status + patch; resetInProgress recovers stuck tasks', async () => {
  const file = tmpFile();
  const t = await enqueuePrimaryTask(buildAcceptTask({ campaignProfileId: 'p2', now: 1 }), file);
  await markTask(t.id, 'in_progress', {}, file);
  await resetInProgress(file);
  const all = await loadTasks(file);
  assert.equal(all[0].status, 'pending');
  await markTask(t.id, 'failed', { lastError: 'boom' }, file);
  const after = await loadTasks(file);
  assert.equal(after[0].status, 'failed');
  assert.equal(after[0].lastError, 'boom');
  rmSync(file, { force: true });
});
