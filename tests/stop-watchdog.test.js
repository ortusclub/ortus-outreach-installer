import test from 'node:test';
import assert from 'node:assert/strict';
import { createStopWatchdog } from '../src/stop-watchdog.js';

function harness(running = true) {
  let callback = null;
  let stuck = 0;
  const watchdog = createStopWatchdog({
    isRunning: () => running,
    onStuck: async () => { stuck++; },
    graceMs: 20_000,
    setTimer: (fn) => { callback = fn; return { unref() {} }; },
    clearTimer: () => { callback = null; },
  });
  return {
    watchdog,
    fire: async () => callback?.(),
    stuck: () => stuck,
    setRunning: (v) => { running = v; },
  };
}

test('watchdog escalates when a stopped campaign is still running', async () => {
  const h = harness(true);
  assert.equal(h.watchdog.arm().armed, true);
  await h.fire();
  assert.equal(h.stuck(), 1);
});

test('watchdog does nothing after graceful campaign cleanup', async () => {
  const h = harness(true);
  h.watchdog.arm();
  h.setRunning(false);
  await h.fire();
  assert.equal(h.stuck(), 0);
});

test('repeated Stop does not postpone the original deadline', () => {
  const h = harness(true);
  const first = h.watchdog.arm({ generation: 1 });
  const second = h.watchdog.arm({ generation: 1 });
  assert.equal(first.armed, true);
  assert.equal(second.armed, false);
  assert.equal(second.requestedAt, first.requestedAt);
});

test('a newer campaign generation replaces a leftover graceful-stop timer', () => {
  const h = harness(true);
  h.watchdog.arm({ generation: 1 });
  const next = h.watchdog.arm({ generation: 2 });
  assert.equal(next.armed, true);
});
