// The hard ceiling that stops a hung GoLogin launch from bricking the app.
//
// Field report 2026-08-21: an operator's local bulk check sat "running" for 30+
// minutes. GL.start() had hung, so the sweep loop was parked inside an await it
// could never leave. A parked await never reaches a `finally`, so the sweep's
// _manualSweepRunning flag never cleared and EVERY later local check answered
// "A bulk check is already running. Wait for it to finish, or press Stop." Both
// instructions were dead ends: waiting never ends, and Stop could not reach the
// parked loop. Only restarting the app cleared it.
//
// withTimeout is the source-level fix: no await on GL.start() can outlive the
// ceiling, so the sweep always reaches its finally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, LAUNCH_TIMEOUT_MS } from '../src/gologin-launcher.js';

test('a promise that never settles rejects at the ceiling instead of hanging', async () => {
  const neverSettles = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(neverSettles, 20, 'GoLogin launch for abc123'),
    /GoLogin launch for abc123 timed out after 0s/,
    'the message must name what hung — the operator needs to know which profile'
  );
});

test('a launch that resolves in time passes its value straight through', async () => {
  const result = await withTimeout(
    Promise.resolve({ status: 'success', wsUrl: 'ws://x' }),
    5000,
    'launch'
  );
  assert.deepEqual(result, { status: 'success', wsUrl: 'ws://x' },
    'the healthy path must be untouched — this ceiling is for the broken case only');
});

test('a real launch failure keeps its own error, not the timeout message', async () => {
  await assert.rejects(
    () => withTimeout(Promise.reject(new Error('GoLogin start failed: status="failure"')), 5000, 'launch'),
    /status="failure"/,
    'swallowing the real cause would make a broken profile look like a slow one'
  );
});

test('the timer is cleared, so a fast launch leaves nothing holding the event loop', async () => {
  // If the ceiling timer outlived the race, a 5-minute handle would keep the
  // process alive after every single launch. Proven by the test run itself:
  // node --test would not exit if the handle leaked.
  await withTimeout(Promise.resolve('ok'), LAUNCH_TIMEOUT_MS, 'launch');
  assert.equal(typeof LAUNCH_TIMEOUT_MS, 'number');
  assert.ok(LAUNCH_TIMEOUT_MS >= 60_000,
    'colleagues run on slow, loaded laptops and cold profiles download first — this is a '
    + '"something is wrong" ceiling, never a performance target');
});
