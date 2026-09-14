import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePrimarySession } from '../src/primary-session-control.js';
import { stopPrimaryTasksForOwner } from '../src/primary-task-control.js';
import { saveTasks } from '../src/primary-tasks.js';

test('prepared session remains owned before dispatch and after a failed normal close', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ortus-session-owner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tasks.json');
  await saveTasks([], file);
  const owner = { campaignId: 'session-fixture', campaignRunId: 'run' };
  let closed = false, attempts = 0;
  const session = await preparePrimarySession([owner], {
    semaphore: { acquire: async () => {}, release() {} },
    launch: async () => ({ page: {} }),
    close: async () => { attempts++; return { browserClosed: closed }; },
  });
  assert.equal((await session.close()).browserClosed, false);
  assert.equal((await stopPrimaryTasksForOwner(owner, { file, timeoutMs: 10 })).stopped, false);
  closed = true;
  assert.equal((await stopPrimaryTasksForOwner(owner, { file, timeoutMs: 100 })).stopped, true);
  assert.equal(attempts, 3, 'Stop retries the retained browser instead of assuming it closed');
});

test('captured foreground cancellation closes a late launch without preparing it', async () => {
  const controller = new AbortController();
  let closes = 0, releases = 0;
  await assert.rejects(preparePrimarySession([{ campaignId: 'late', campaignRunId: 'run' }], {
    signal: controller.signal,
    semaphore: { acquire: async () => {}, release() { releases++; } },
    launch: async () => { controller.abort(); return { page: {} }; },
    prepare: async () => assert.fail('must not prepare a cancelled browser'),
    close: async () => { closes++; return { browserClosed: true }; },
  }), /cancelled/);
  assert.equal(closes, 1);
  assert.equal(releases, 1);
});
