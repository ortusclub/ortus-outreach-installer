import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideThrottle } from '../src/resource-monitor.js';

const cfg = {
  RAM_THROTTLE_PCT: 80,
  RAM_RELEASE_PCT: 70,
  CPU_THROTTLE_LOAD_FACTOR: 0.9,
  CPU_RELEASE_LOAD_FACTOR: 0.7,
  THROTTLE_MULTIPLIER: 2,
  PARK_PAGE: 'about:blank',
  IDLE_PARKING_ENABLED: true,
};

const idle = { active: false, reason: '', multiplier: 1 };
const active = { active: true, reason: 'RAM 85%', multiplier: 2 };

test('engages on high RAM (D-05)', () => {
  const next = decideThrottle(idle, { ramPct: 85, load1: 1.0, cpuCount: 8 }, cfg);
  assert.equal(next.active, true);
  assert.equal(next.multiplier, 2);
  assert.match(next.reason, /RAM/);
});

test('engages on high load (D-05)', () => {
  const next = decideThrottle(idle, { ramPct: 50, load1: 7.5, cpuCount: 8 }, cfg);
  assert.equal(next.active, true);
  assert.equal(next.multiplier, 2);
  assert.match(next.reason, /load1/);
});

test('releases only when BOTH low (D-06) — ram low, load high → stay active', () => {
  const next = decideThrottle(active, { ramPct: 60, load1: 7.0, cpuCount: 8 }, cfg);
  assert.equal(next.active, true);
  assert.equal(next.multiplier, 2);
});

test('releases only when BOTH low (D-06) — ram high, load low → stay active', () => {
  const next = decideThrottle(active, { ramPct: 85, load1: 2.0, cpuCount: 8 }, cfg);
  assert.equal(next.active, true);
  assert.equal(next.multiplier, 2);
});

test('releases when ram low AND load low (D-06)', () => {
  const next = decideThrottle(active, { ramPct: 60, load1: 3.0, cpuCount: 8 }, cfg);
  assert.equal(next.active, false);
  assert.equal(next.multiplier, 1);
});

test('hysteresis band: ram=75, load=5.5 (between 70/80 and 5.6/7.2) keeps prior state', () => {
  const staysIdle = decideThrottle(idle, { ramPct: 75, load1: 5.5, cpuCount: 8 }, cfg);
  const staysActive = decideThrottle(active, { ramPct: 75, load1: 5.5, cpuCount: 8 }, cfg);
  assert.equal(staysIdle.active, false);
  assert.equal(staysActive.active, true);
});

test('multiplier is THROTTLE_MULTIPLIER when active, 1 when idle (D-07)', () => {
  const engaged = decideThrottle(idle, { ramPct: 90, load1: 1.0, cpuCount: 8 }, cfg);
  assert.equal(engaged.multiplier, cfg.THROTTLE_MULTIPLIER);

  const released = decideThrottle(active, { ramPct: 50, load1: 1.0, cpuCount: 8 }, cfg);
  assert.equal(released.multiplier, 1);
});

test('reason string combines RAM and load1 when both above release bands', () => {
  const next = decideThrottle(idle, { ramPct: 90, load1: 7.5, cpuCount: 8 }, cfg);
  assert.equal(next.active, true);
  assert.match(next.reason, /RAM/);
  assert.match(next.reason, /load1/);
  assert.match(next.reason, /\+/);
});
