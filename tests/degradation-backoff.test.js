import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isDegradationSignal, degradationBackoffMs } from '../src/campaign.js';

// ─────────────────────────────────────────────────────────────────────────
// v2.96.0 (Phase 2) — degradation backoff. The connect loop ran at a fixed
// 15-45s pace regardless of how many leads mis-loaded; under LinkedIn
// rate-limiting that hammered a degrading session. These two pure helpers drive
// the per-account "slow down, then park" response.
// ─────────────────────────────────────────────────────────────────────────

// ── isDegradationSignal: which outcomes mean "the session is degrading" ──

test('flags the real degradation signals seen in the incident logs', () => {
  assert.equal(isDegradationSignal('Execution context was destroyed, most likely because of a navigation'), true);
  assert.equal(isDegradationSignal('lead_timeout_watchdog'), true);
  assert.equal(isDegradationSignal('Profile not found'), true);
  assert.equal(isDegradationSignal('Navigation timeout of 15000 ms exceeded'), true);
  assert.equal(isDegradationSignal('net::ERR_TIMED_OUT'), true);
  assert.equal(isDegradationSignal('rate_limited'), true);
  assert.equal(isDegradationSignal('Identity unverified after 5 attempts'), true);
  assert.equal(isDegradationSignal('identity-unverified: no-member-number-captured'), true);
});

test('does NOT flag benign skips that should not escalate backoff', () => {
  assert.equal(isDegradationSignal('already_connected'), false);
  assert.equal(isDegradationSignal('Already in target state'), false);
  assert.equal(isDegradationSignal('Not Open Profile'), false);
  assert.equal(isDegradationSignal(''), false);
  assert.equal(isDegradationSignal(null), false);
  assert.equal(isDegradationSignal(undefined), false);
});

// ── degradationBackoffMs: exponential, capped, reset-friendly ──

test('streak 0 leaves the base delay untouched', () => {
  assert.equal(degradationBackoffMs(30000, 0), 30000);
});

test('each consecutive degraded lead doubles the wait', () => {
  assert.equal(degradationBackoffMs(30000, 1), 60000);   // 2×
  assert.equal(degradationBackoffMs(30000, 2), 120000);  // 4×
  assert.equal(degradationBackoffMs(30000, 3), 240000);  // 8×
});

test('the multiplier is capped by maxMult', () => {
  // 2**10 would be 1024×; capped at maxMult=32 → 30000 * 32 = 960000.
  assert.equal(degradationBackoffMs(30000, 10, { maxMult: 32, maxMs: 60 * 60 * 1000 }), 960000);
});

test('the absolute ceiling (maxMs) is never exceeded', () => {
  assert.equal(degradationBackoffMs(30000, 10, { maxMult: 1000, maxMs: 20 * 60 * 1000 }), 20 * 60 * 1000);
});

test('negative / garbage streak is treated as no backoff', () => {
  assert.equal(degradationBackoffMs(30000, -3), 30000);
  assert.equal(degradationBackoffMs(30000, NaN), 30000);
});
