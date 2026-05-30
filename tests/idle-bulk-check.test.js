import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck } from '../src/campaign.js';

// v2.71: first-hour blackout + 1/hr-per-account cap. Both gates now 60 min.
const baseInput = () => ({
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (75 * 60 * 1000), // 75 min ago — past 60-min gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (65 * 60 * 1000),   // 65 min ago — past 60-min cooldown
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

// v2.62: connect_and_message (CC+DM) shares the connect-then-followup
// loop with connect_and_introduce — idle bulk-checks apply equally.
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

test('skips when cooldown not elapsed (60-min floor)', () => {
  const input = { ...baseInput(), lastBulkCheckAt: Date.now() - (30 * 60 * 1000) }; // 30 min ago
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('fires when cooldown elapsed by exactly the floor (boundary)', () => {
  const t = Date.now();
  const input = { ...baseInput(), now: t, lastBulkCheckAt: t - (60 * 60 * 1000) }; // exactly 60 min
  assert.equal(shouldFireIdleBulkCheck(input), true);
});
