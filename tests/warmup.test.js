import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WARMUP_SCHEDULE,
  WARMUP_WEEKS,
  warmupWeek,
  warmupStatus,
  effectiveDailyLimit,
} from '../src/warmup.js';

const DAY = 24 * 60 * 60 * 1000;
const START = '2026-07-01T00:00:00.000Z';
const at = (days) => new Date(new Date(START).getTime() + days * DAY);

test('schedule is the approved 5/10/20 ramp over 3 weeks', () => {
  assert.deepEqual(WARMUP_SCHEDULE, [5, 10, 20]);
  assert.equal(WARMUP_WEEKS, 3);
});

test('warmupWeek: calendar-week boundaries from startedAt', () => {
  assert.equal(warmupWeek(START, at(0)), 1);
  assert.equal(warmupWeek(START, at(6.99)), 1);
  assert.equal(warmupWeek(START, at(7)), 2);
  assert.equal(warmupWeek(START, at(13.99)), 2);
  assert.equal(warmupWeek(START, at(14)), 3);
  assert.equal(warmupWeek(START, at(20.99)), 3);
  assert.equal(warmupWeek(START, at(21)), 4); // ramp complete
});

test('warmupWeek: garbage/missing startedAt → null; future start → week 1', () => {
  assert.equal(warmupWeek(null, at(0)), null);
  assert.equal(warmupWeek('not-a-date', at(0)), null);
  assert.equal(warmupWeek(at(5).toISOString(), at(0)), 1); // clock skew
});

test('warmupStatus: disabled or unparseable → inactive', () => {
  assert.deepEqual(warmupStatus({ enabled: false, startedAt: START, now: at(1) }),
    { active: false, complete: false, week: null, cap: null });
  assert.deepEqual(warmupStatus({ enabled: true, startedAt: 'junk', now: at(1) }),
    { active: false, complete: false, week: null, cap: null });
  assert.deepEqual(warmupStatus(), { active: false, complete: false, week: null, cap: null });
});

test('warmupStatus: active weeks carry the right cap', () => {
  assert.deepEqual(warmupStatus({ enabled: true, startedAt: START, now: at(1) }),
    { active: true, complete: false, week: 1, cap: 5 });
  assert.deepEqual(warmupStatus({ enabled: true, startedAt: START, now: at(8) }),
    { active: true, complete: false, week: 2, cap: 10 });
  assert.deepEqual(warmupStatus({ enabled: true, startedAt: START, now: at(15) }),
    { active: true, complete: false, week: 3, cap: 20 });
});

test('warmupStatus: week 4+ → complete, no cap', () => {
  const st = warmupStatus({ enabled: true, startedAt: START, now: at(22) });
  assert.equal(st.active, false);
  assert.equal(st.complete, true);
  assert.equal(st.cap, null);
});

test('effectiveDailyLimit: caps by week while warming', () => {
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: START, now: at(1) }), 5);
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: START, now: at(8) }), 10);
  assert.equal(effectiveDailyLimit({ configuredLimit: 50, warmupStartedAt: START, now: at(15) }), 20);
});

test('effectiveDailyLimit: never RAISES the configured limit', () => {
  // Campaign configured below the week-3 cap keeps its own limit.
  assert.equal(effectiveDailyLimit({ configuredLimit: 8, warmupStartedAt: START, now: at(15) }), 8);
  assert.equal(effectiveDailyLimit({ configuredLimit: 3, warmupStartedAt: START, now: at(1) }), 3);
});

test('effectiveDailyLimit: no warm-up (or complete) → configured limit', () => {
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: null, now: at(1) }), 20);
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: undefined, now: at(1) }), 20);
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: START, now: at(21) }), 20);
  assert.equal(effectiveDailyLimit({ configuredLimit: 20, warmupStartedAt: 'junk', now: at(1) }), 20);
});
