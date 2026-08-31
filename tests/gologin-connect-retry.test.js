import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectWithRetry, CONNECT_RETRY_DELAYS_MS } from '../src/gologin-launcher.js';

const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:23983'), { code: 'ECONNREFUSED' });
const noSleep = () => Promise.resolve();

test('a browser that is still binding its port is attached to on the retry', async () => {
  let calls = 0;
  const browser = await connectWithRetry(async () => {
    calls += 1;
    if (calls < 2) throw refused();
    return 'browser';
  }, { pid: 123, isAlive: () => true, sleep: noSleep });
  assert.equal(browser, 'browser');
  assert.equal(calls, 2, 'should have succeeded on the second attempt');
});

test('three attempts in total, then the original error is thrown', async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(
    connectWithRetry(async () => { calls += 1; throw refused(); },
      { pid: 123, isAlive: () => true, sleep: async (ms) => { waits.push(ms); } }),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 3, 'one attempt plus two retries');
  assert.deepEqual(waits, [2000, 4000], 'short backoff, not a flat 5s');
});

test('a dead browser process is not waited for', async () => {
  // No port will ever open, so spending the backoff only slows down every other
  // account still queued behind this one in the sweep.
  let calls = 0;
  const waits = [];
  await assert.rejects(
    connectWithRetry(async () => { calls += 1; throw refused(); },
      { pid: 123, isAlive: () => false, sleep: async (ms) => { waits.push(ms); } }),
    /ECONNREFUSED/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(waits, [], 'failed immediately instead of backing off');
});

test('reaching the browser and failing for another reason is not retried', async () => {
  // We got through to it, so the port is fine and repeating the call would only
  // delay a real failure the operator needs to see.
  let calls = 0;
  await assert.rejects(
    connectWithRetry(async () => { calls += 1; throw new Error('Protocol error: Target.setDiscoverTargets'); },
      { pid: 123, isAlive: () => true, sleep: noSleep }),
    /Protocol error/,
  );
  assert.equal(calls, 1);
});

test('the first attempt is immediate', async () => {
  const waits = [];
  const r = await connectWithRetry(async () => 'ok',
    { pid: 1, isAlive: () => true, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r, 'ok');
  assert.deepEqual(waits, [], 'a healthy launch pays nothing for the retry');
});

test('the backoff is short by design', () => {
  assert.deepEqual(CONNECT_RETRY_DELAYS_MS, [2000, 4000]);
  const total = CONNECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(total <= 6000, `worst case adds ${total}ms to an account that is never coming up`);
});
