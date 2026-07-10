import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekKey } from '../src/cloud-soo-reconcile.js';

// isoWeekKey is load-bearing for the cloud SoO connection tally: a wrong week
// bucket would credit a send to the wrong week's count. Lock its boundaries.

test('same ISO week → same key (the cloud-parity test case)', () => {
  // 2026-07-09 (Thu) and 2026-07-10 (Fri) are the same ISO week.
  assert.equal(isoWeekKey(new Date('2026-07-09T19:30:48Z')), '2026-W28');
  assert.equal(isoWeekKey(new Date('2026-07-10T00:00:00Z')), '2026-W28');
});

test('adjacent weeks differ', () => {
  // 2026-07-05 is Sunday (end of W27); 2026-07-06 is Monday (start of W28).
  assert.equal(isoWeekKey(new Date('2026-07-05T12:00:00Z')), '2026-W27');
  assert.equal(isoWeekKey(new Date('2026-07-06T12:00:00Z')), '2026-W28');
});

test('Monday starts a new ISO week, Sunday ends the prior one', () => {
  const sun = isoWeekKey(new Date('2026-07-05T23:00:00Z')); // Sunday
  const mon = isoWeekKey(new Date('2026-07-06T01:00:00Z')); // Monday
  assert.notEqual(sun, mon);
  assert.equal(sun, '2026-W27');
  assert.equal(mon, '2026-W28');
});

test('ISO year rollover: 2025-12-29 (Mon) is week 1 of 2026', () => {
  // 2025-12-29 through 2026-01-04 is ISO week 2026-W01.
  assert.equal(isoWeekKey(new Date('2025-12-29T00:00:00Z')), '2026-W01');
  assert.equal(isoWeekKey(new Date('2026-01-04T00:00:00Z')), '2026-W01');
});

test('first ISO week of 2026 example dates agree', () => {
  assert.equal(isoWeekKey(new Date('2026-01-01T00:00:00Z')), '2026-W01');
});
