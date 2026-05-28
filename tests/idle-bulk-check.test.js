import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFireIdleBulkCheck } from '../src/campaign.js';

const baseInput = () => ({
  mode: 'connect_and_introduce',
  campaignStartTime: Date.now() - (45 * 60 * 1000), // 45 min ago — past 30-min gate
  profileBrowserOpen: false,
  profileWeeklyLimited: false,
  semaphoreAvailable: 1,
  lastBulkCheckAt: Date.now() - (6 * 60 * 1000),    // 6 min ago — past 5-min cooldown
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

test('skips when campaign uptime < 30 min', () => {
  const input = { ...baseInput(), campaignStartTime: Date.now() - (20 * 60 * 1000) };
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

test('skips when cooldown not elapsed (5-min floor)', () => {
  const input = { ...baseInput(), lastBulkCheckAt: Date.now() - (2 * 60 * 1000) }; // 2 min ago
  assert.equal(shouldFireIdleBulkCheck(input), false);
});

test('fires when cooldown elapsed by exactly the floor (boundary)', () => {
  const t = Date.now();
  const input = { ...baseInput(), now: t, lastBulkCheckAt: t - (5 * 60 * 1000) }; // exactly 5 min
  assert.equal(shouldFireIdleBulkCheck(input), true);
});
