import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCapacity, WARN_DAYS } from '../src/capacity-forecast.js';

const NOW = new Date('2026-07-07T09:00:00Z').getTime();

test('basic forecast: 24 targets at 4/day × 2 accounts = 8/day → 3 days', () => {
  const r = forecastCapacity({ targetCount: 24, dailyLimit: 4, accountCount: 2, now: NOW });
  assert.equal(r.perDay, 8);
  assert.equal(r.days, 3);
  assert.equal(r.finishDate.getTime(), NOW + 3 * 86400000);
});

test('partial last day rounds up', () => {
  const r = forecastCapacity({ targetCount: 25, dailyLimit: 4, accountCount: 2, now: NOW });
  assert.equal(r.days, 4);
});

test('list smaller than one day of capacity → 1 day', () => {
  const r = forecastCapacity({ targetCount: 5, dailyLimit: 50, accountCount: 3, now: NOW });
  assert.equal(r.perDay, 150);
  assert.equal(r.days, 1);
});

test('accepts a Date for now', () => {
  const r = forecastCapacity({ targetCount: 8, dailyLimit: 8, accountCount: 1, now: new Date(NOW) });
  assert.equal(r.finishDate.getTime(), NOW + 86400000);
});

test('returns null on missing/non-positive inputs', () => {
  assert.equal(forecastCapacity(), null);
  assert.equal(forecastCapacity({ targetCount: 0, dailyLimit: 50, accountCount: 2 }), null);
  assert.equal(forecastCapacity({ targetCount: 100, dailyLimit: 0, accountCount: 2 }), null);
  assert.equal(forecastCapacity({ targetCount: 100, dailyLimit: 50, accountCount: 0 }), null);
  assert.equal(forecastCapacity({ targetCount: NaN, dailyLimit: 50, accountCount: 2 }), null);
  assert.equal(forecastCapacity({ targetCount: '', dailyLimit: 50, accountCount: 2 }), null);
});

test('coerces numeric strings (input .value comes in as string)', () => {
  const r = forecastCapacity({ targetCount: '100', dailyLimit: '50', accountCount: '2', now: NOW });
  assert.equal(r.perDay, 100);
  assert.equal(r.days, 1);
});

test('WARN_DAYS matches the list_vs_limit lint threshold (14 days)', () => {
  assert.equal(WARN_DAYS, 14);
  // Lint fires when targetCount > 14 × perDay ⇔ days > 14 here.
  const perDay = 100; // 50 × 2
  const atThreshold = forecastCapacity({ targetCount: 14 * perDay, dailyLimit: 50, accountCount: 2, now: NOW });
  assert.equal(atThreshold.days, WARN_DAYS); // not over
  const overThreshold = forecastCapacity({ targetCount: 14 * perDay + 1, dailyLimit: 50, accountCount: 2, now: NOW });
  assert.equal(overThreshold.days, WARN_DAYS + 1); // over → amber
});
