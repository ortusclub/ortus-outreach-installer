import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isTransientWriteError, withWriteRetry } from '../src/sheets-writer.js';

// A single transient Apps Script timeout currently drops the row permanently
// (no retry). These guard the retry/backoff that makes idempotent writes
// self-heal across a one-off latency spike.

test('isTransientWriteError: timeout / network errors are transient', () => {
  assert.equal(isTransientWriteError('The operation was aborted due to timeout'), true);
  assert.equal(isTransientWriteError('fetch failed'), true);
  assert.equal(isTransientWriteError('ECONNRESET'), true);
  assert.equal(isTransientWriteError('socket hang up'), true);
});

test('isTransientWriteError: permanent errors are NOT transient', () => {
  assert.equal(isTransientWriteError('Authentication error — redeploy the Apps Script'), false);
  assert.equal(isTransientWriteError('Row not found for: https://x'), false);
  assert.equal(isTransientWriteError('No LinkedIn URL column found'), false);
  assert.equal(isTransientWriteError(''), false);
  assert.equal(isTransientWriteError(undefined), false);
});

const noSleep = () => Promise.resolve();

test('withWriteRetry: returns immediately on first success', async () => {
  let calls = 0;
  const r = await withWriteRetry(async () => { calls++; return { success: true }; },
    { maxAttempts: 3, sleep: noSleep });
  assert.deepEqual(r, { success: true });
  assert.equal(calls, 1);
});

test('withWriteRetry: retries a transient error then succeeds', async () => {
  let calls = 0;
  const r = await withWriteRetry(async () => {
    calls++;
    if (calls < 3) return { error: 'The operation was aborted due to timeout' };
    return { success: true };
  }, { maxAttempts: 3, sleep: noSleep });
  assert.deepEqual(r, { success: true });
  assert.equal(calls, 3);
});

test('withWriteRetry: does NOT retry a permanent error', async () => {
  let calls = 0;
  const r = await withWriteRetry(async () => { calls++; return { error: 'Row not found for: x' }; },
    { maxAttempts: 3, sleep: noSleep });
  assert.equal(r.error, 'Row not found for: x');
  assert.equal(calls, 1);
});

test('withWriteRetry: gives up after maxAttempts on persistent transient error', async () => {
  let calls = 0;
  const r = await withWriteRetry(async () => { calls++; return { error: 'timeout' }; },
    { maxAttempts: 3, sleep: noSleep });
  assert.equal(r.error, 'timeout');
  assert.equal(calls, 3);
});

test('withWriteRetry: passes through a null result (no webapp configured)', async () => {
  const r = await withWriteRetry(async () => null, { maxAttempts: 3, sleep: noSleep });
  assert.equal(r, null);
});
