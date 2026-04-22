// Integration-style test for Plan 02: confirms the primitives wire together
// the way the round-robin loop needs. Does NOT launch a browser or run a
// real campaign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideThrottle, computeDelayMultiplier, loadConfig } from '../src/resource-monitor.js';
import { parkProfile } from '../src/campaign.js';

test('single-profile + high RAM → loop picks 4x multiplier', () => {
  const cfg = loadConfig();
  const state = { active: false, reason: '', multiplier: 1 };
  const highRamSample = { ramPct: 92, load1: 1.0, cpuCount: 8 };
  const throttle = decideThrottle(state, highRamSample, cfg);
  assert.equal(throttle.active, true);
  assert.equal(throttle.multiplier, 2);

  const mult = computeDelayMultiplier({
    mode: 'connect_only',
    profileCount: 1,
    throttleActive: throttle.active,
    throttleMultiplier: throttle.multiplier,
  });
  assert.equal(mult, 4, 'single-profile 2x * throttled 2x = 4x per D-08');
});

test('multi-profile + high load → loop picks 2x multiplier', () => {
  const cfg = loadConfig();
  const state = { active: false, reason: '', multiplier: 1 };
  const highLoadSample = { ramPct: 50, load1: 9.0, cpuCount: 8 };
  const throttle = decideThrottle(state, highLoadSample, cfg);
  assert.equal(throttle.active, true);

  const mult = computeDelayMultiplier({
    mode: 'connect_only',
    profileCount: 5,
    throttleActive: throttle.active,
    throttleMultiplier: throttle.multiplier,
  });
  assert.equal(mult, 2, 'multi-profile 1x * throttled 2x = 2x');
});

test('message_only mode ignores throttle (D-09-style semantics preserved)', () => {
  const cfg = loadConfig();
  const throttle = { active: true, reason: 'RAM 88%', multiplier: 2 };
  const mult = computeDelayMultiplier({
    mode: 'message_only',
    profileCount: 1,
    throttleActive: throttle.active,
    throttleMultiplier: throttle.multiplier,
  });
  assert.equal(mult, 1);
});

test('parkProfile respects a non-default PARK_PAGE url (D-14 knob)', async () => {
  const calls = [];
  const page = { goto: async (url, opts) => { calls.push({ url, opts }); }, isClosed: () => false };
  await parkProfile(page, 'https://www.google.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://www.google.com');
  assert.equal(calls[0].opts.waitUntil, 'domcontentloaded');
});

test('parkProfile is a no-op when page.isClosed() returns true', async () => {
  let called = false;
  const page = { goto: async () => { called = true; }, isClosed: () => true };
  await parkProfile(page, 'about:blank');
  assert.equal(called, false);
});
