import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck } from '../src/campaign.js';

// The between-checks interval is now the operator cadence, passed in as
// intervalMs. The first-hour age gate (campaignStartTime) is unchanged.
const ONE_HOUR = 60 * 60 * 1000;
const baseInput = () => ({
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (75 * 60 * 1000), // 75 min ago — past 60-min age gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (2 * ONE_HOUR), // 2h ago — past a 1h cadence
  intervalMs: ONE_HOUR,                          // operator picked "every hour"
  now: Date.now(),
});

test('fires when all gates pass', () => {
  assert.equal(shouldFireIdleBulkCheck(baseInput()), true);
});

test('skips when mode is not a connect-then-followup mode', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'message_only' }), false);
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'introduce_back' }), false);
});

test('fires when mode is connect_and_message', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), mode: 'connect_and_message' }), true);
});

test('skips when campaign uptime < 60 min (first-hour blackout)', () => {
  const input = { ...baseInput(), campaignStartTime: Date.now() - (45 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('skips when profile browser is open (in-batch trigger owns it)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileBrowserOpen: true }), false);
});

test('skips when profile is parked permanently (weeklyLimited)', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), profileWeeklyLimited: true }), false);
});

test('skips when semaphore has no available slot', () => {
  assert.equal(shouldFireIdleBulkCheck({ ...baseInput(), semaphoreAvailable: 0 }), false);
});

test('HONORS the operator cadence: skips when interval not yet elapsed', () => {
  // 30 min since last check, but operator picked every hour → not due yet.
  const input = { ...baseInput(), lastBulkCheckAt: Date.now() - (30 * 60 * 1000) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('HONORS the operator cadence: a 6h pick is NOT due at 2h', () => {
  const input = { ...baseInput(), intervalMs: 6 * ONE_HOUR, lastBulkCheckAt: Date.now() - (2 * ONE_HOUR) };
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('fires when the operator interval elapses exactly (boundary)', () => {
  const t = Date.now();
  const input = { ...baseInput(), now: t, intervalMs: ONE_HOUR, lastBulkCheckAt: t - ONE_HOUR };
  assert.equal(shouldFireIdleBulkCheck(input), true);
});
