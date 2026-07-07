import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  writeSheetWithRetry,
  getFailures,
  clearFailures,
  retryFailures,
  recordFailure,
  configure,
} = await import('../src/sheet-write-tracker.js');

const noSleep = async () => {};

beforeEach(() => {
  clearFailures();
});

test('retry-once on thrown error: fn throws on attempt 1, succeeds on attempt 2; no failure recorded', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) throw new Error('transient');
    return { ok: true };
  };
  const result = await writeSheetWithRetry(fn, {}, { retryDelayMs: 1, sleep: noSleep });
  assert.equal(calls, 2);
  assert.deepEqual(result, { ok: true });
  assert.equal(getFailures().length, 0);
});

test('retry-once on result.error: fn returns {error} on attempt 1, returns {} on attempt 2; no failure recorded', async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) return { error: 'timeout' };
    return {};
  };
  await writeSheetWithRetry(fn, {}, { retryDelayMs: 1, sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(getFailures().length, 0);
});

test('ledger recording on double failure: fn always throws; getFailures() has 1 entry with correct fields', async () => {
  const meta = { url: 'https://linkedin.com/in/test', leadName: 'Test User', column: 'Status', payload: 'Connected' };
  const fn = async () => { throw new Error('sheet error'); };
  await writeSheetWithRetry(fn, meta, { retryDelayMs: 1, sleep: noSleep });
  const failures = getFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, meta.url);
  assert.equal(failures[0].leadName, meta.leadName);
  assert.equal(failures[0].attempts, 2);
  assert.ok(failures[0].timestamp);
  assert.ok(failures[0].errorMessage);
});

test('ledger recording on double result.error: fn always returns {error}; errorMessage is set', async () => {
  const fn = async () => ({ error: 'oops' });
  await writeSheetWithRetry(fn, { url: 'u', leadName: 'L', column: 'C', payload: 'P' }, { retryDelayMs: 1, sleep: noSleep });
  const failures = getFailures();
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorMessage, 'oops');
  assert.equal(failures[0].attempts, 2);
});

test('retryFailures clears successes, leaves still-failing; correct counts', async () => {
  // Seed two failures
  recordFailure({ url: 'u1', leadName: 'A', column: 'C', payload: 'P', errorMessage: 'e', timestamp: new Date().toISOString(), attempts: 2 });
  recordFailure({ url: 'u2', leadName: 'B', column: 'C', payload: 'P', errorMessage: 'e', timestamp: new Date().toISOString(), attempts: 2 });
  assert.equal(getFailures().length, 2);

  // retryFn succeeds for u1, fails for u2
  const retryFn = async (failure) => {
    if (failure.url === 'u1') return {};
    throw new Error('still broken');
  };
  const result = await retryFailures(retryFn);
  assert.equal(result.retried, 2);
  assert.equal(result.stillFailing, 1);
  const remaining = getFailures();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].url, 'u2');
});

test('clearFailures empties the ledger', async () => {
  const fn = async () => { throw new Error('x'); };
  await writeSheetWithRetry(fn, {}, { retryDelayMs: 1, sleep: noSleep });
  assert.ok(getFailures().length > 0);
  clearFailures();
  assert.equal(getFailures().length, 0);
});

test('non-blocking: fn throws both times → writeSheetWithRetry resolves (does not propagate throw)', async () => {
  const fn = async () => { throw new Error('always fails'); };
  // Must resolve, not reject
  await assert.doesNotReject(() =>
    writeSheetWithRetry(fn, {}, { retryDelayMs: 1, sleep: noSleep })
  );
});
