import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCooldownMs } from '../src/post-campaign-bulk-check.js';

test('production mode: always returns 6 hours, regardless of sweepCount', () => {
  const sixHours = 6 * 60 * 60 * 1000;
  assert.equal(computeCooldownMs({ isTestMode: false, sweepCount: 0 }), sixHours);
  assert.equal(computeCooldownMs({ isTestMode: false, sweepCount: 1 }), sixHours);
  assert.equal(computeCooldownMs({ isTestMode: false, sweepCount: 99 }), sixHours);
});

test('test mode, first sweep (sweepCount=0): returns 60 seconds', () => {
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: 0 }), 60_000);
});

test('test mode, subsequent sweep (sweepCount>=1): returns 5 minutes', () => {
  const fiveMin = 5 * 60 * 1000;
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: 1 }), fiveMin);
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: 7 }), fiveMin);
});

test('test mode, missing sweepCount field: treated as 0 → 60 seconds (fresh registration)', () => {
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: undefined }), 60_000);
  assert.equal(computeCooldownMs({ isTestMode: true }), 60_000);
});

test('test mode, falsy sweepCount values: treated as 0', () => {
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: null }), 60_000);
  assert.equal(computeCooldownMs({ isTestMode: true, sweepCount: 0 }), 60_000);
});
