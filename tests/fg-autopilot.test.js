import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleKey, isRunDay, nextRun, shouldFire, fgCriteria, buildAutopilotConfig,
} from '../src/fg-autopilot.js';

// --- cycleKey uses the LONDON calendar day, not UTC ---
test('cycleKey returns the London calendar day', () => {
  // 2026-08-01T00:30:00Z — London is BST (UTC+1) in August, so it's already 01:30 on Aug 1.
  assert.equal(cycleKey(new Date('2026-08-01T00:30:00Z')), '2026-08-01');
});
test('cycleKey rolls to the next London day when UTC is still the previous day', () => {
  // 2026-08-14T23:30:00Z — BST → 2026-08-15T00:30 London → the 15th.
  assert.equal(cycleKey(new Date('2026-08-14T23:30:00Z')), '2026-08-15');
});

// --- isRunDay ---
test('isRunDay true on the 1st and 15th, false otherwise', () => {
  assert.equal(isRunDay(new Date('2026-08-01T06:00:00+01:00')), true);
  assert.equal(isRunDay(new Date('2026-08-15T06:00:00+01:00')), true);
  assert.equal(isRunDay(new Date('2026-08-02T06:00:00+01:00')), false);
});
test('isRunDay respects a custom days array', () => {
  assert.equal(isRunDay(new Date('2026-08-20T06:00:00+01:00'), [1, 20]), true);
  assert.equal(isRunDay(new Date('2026-08-15T06:00:00+01:00'), [1, 20]), false);
});

// --- nextRun ---
test('nextRun returns null when disabled', () => {
  assert.equal(nextRun(new Date('2026-07-16T09:00:00Z'), { enabled: false }), null);
});
test('nextRun from mid-month points to the 1st of next month at 06:00 London', () => {
  const d = nextRun(new Date('2026-07-16T09:00:00Z'), { days: [1, 15] });
  assert.equal(cycleKey(d), '2026-08-01');
  // 06:00 London on 2026-08-01 (BST) === 05:00Z
  assert.equal(d.toISOString(), '2026-08-01T05:00:00.000Z');
});
test('nextRun on a run day before 06:00 returns today; after 06:00 returns the next run day', () => {
  const before = nextRun(new Date('2026-08-01T03:00:00Z'), { days: [1, 15] }); // 04:00 London, before 06:00
  assert.equal(cycleKey(before), '2026-08-01');
  const after = nextRun(new Date('2026-08-01T09:00:00Z'), { days: [1, 15] }); // 10:00 London, after 06:00
  assert.equal(cycleKey(after), '2026-08-15');
});
test('nextRun steps by local calendar day, not UTC milliseconds (DST-correct)', () => {
  // UK spring-forward: 2026-03-29T01:00:00 GMT → 2026-03-29T02:00:00 BST (skipped 01:00-02:00).
  // If we step by fixed 86400000ms (24h UTC), we jump from 2026-03-28T23:30:00Z (Mar 28 London)
  // directly to 2026-03-29T23:30:00Z (Mar 30 London), SKIPPING the 29th.
  // This test confirms the fix: nextRun must sample the 29th if days includes it.
  const result = nextRun(new Date('2026-03-28T23:30:00Z'), { days: [1, 15, 29] });
  assert.equal(cycleKey(result), '2026-03-29', 'nextRun must not skip March 29 across DST spring-forward');
});

// --- shouldFire truth table ---
const cfg = { enabled: true, days: [1, 15], pairs: [{ profileId: 'p1' }], keywords: ['x'] };
test('shouldFire: disabled', () => {
  assert.equal(shouldFire(new Date('2026-08-01T06:00:00+01:00'), { ...cfg, enabled: false }, []).reason, 'disabled');
});
test('shouldFire: no pairs', () => {
  assert.equal(shouldFire(new Date('2026-08-01T06:00:00+01:00'), { ...cfg, pairs: [] }, []).reason, 'no-pairs');
});
test('shouldFire: not a run day', () => {
  assert.equal(shouldFire(new Date('2026-08-02T06:00:00+01:00'), cfg, []).reason, 'not-a-run-day');
});
test('shouldFire: already ran this cycle', () => {
  const r = shouldFire(new Date('2026-08-01T06:00:00+01:00'), cfg, ['2026-08-01']);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'already-ran');
});
test('shouldFire: fire', () => {
  const r = shouldFire(new Date('2026-08-01T06:00:00+01:00'), cfg, ['2026-07-15']);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'fire');
  assert.equal(r.cycleKey, '2026-08-01');
});

// --- fgCriteria ---
test('fgCriteria wraps keywords into jobTitles + empty companies/geo', () => {
  assert.deepEqual(fgCriteria(['marketing', 'founder']), { jobTitles: ['marketing', 'founder'], companies: [], geo: [] });
});

// --- buildAutopilotConfig ---
test('buildAutopilotConfig drops local-browser pairs and defaults keywords', () => {
  const cfg2 = buildAutopilotConfig({
    pairs: [
      { operator: 'o', account: 'a@x', profileId: 'gl-1', operatorName: 'O' },
      { operator: 'o2', account: 'b@x', profileId: 'local-browser', operatorName: 'O2' },
    ],
    keywords: [],
    marketerDefaults: ['marketing'],
    publishedBy: 'ortus@x',
    publishedAt: '2026-07-16T00:00:00.000Z',
  });
  assert.equal(cfg2.pairs.length, 1);
  assert.equal(cfg2.pairs[0].profileId, 'gl-1');
  assert.deepEqual(cfg2.keywords, ['marketing']);
  assert.equal(cfg2.enabled, true);
  assert.deepEqual(cfg2.days, [1, 15]);
});
