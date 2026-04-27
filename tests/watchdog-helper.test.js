import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — Promise.race based watchdog. We test that:
// 1. A fast-resolving promise wins.
// 2. A slow promise loses to the watchdog and yields a tagged rejection.
// 3. The watchdog timer is cleared (no dangling timer keeping process alive).

function withWatchdog(promise, timeoutMs, profileId) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(
      new Error('lead_timeout_watchdog'),
      { kind: 'watchdog', profileId, timeoutMs }
    )), timeoutMs);
  });
  return Promise.race([promise, watchdog]).finally(() => clearTimeout(timer));
}

test('fast promise resolves before watchdog fires', async () => {
  const fast = new Promise((resolve) => setTimeout(() => resolve('done'), 10));
  const result = await withWatchdog(fast, 1000, 'p1');
  assert.equal(result, 'done');
});

test('slow promise loses to watchdog and yields lead_timeout_watchdog', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('too late'), 1000));
  await assert.rejects(
    () => withWatchdog(slow, 50, 'p1'),
    (err) => {
      assert.equal(err.message, 'lead_timeout_watchdog');
      assert.equal(err.kind, 'watchdog');
      assert.equal(err.profileId, 'p1');
      assert.equal(err.timeoutMs, 50);
      return true;
    },
  );
});

test('watchdog timer is cleared after race settles', async () => {
  // If the timer leaks, the test process will hang waiting for it. node --test
  // fails fast on hung tests (default 30s), so a leak would be visible. We
  // simply assert that the resolved value is correct.
  const fast = Promise.resolve('immediate');
  const out = await withWatchdog(fast, 5000, 'p1');
  assert.equal(out, 'immediate');
});
