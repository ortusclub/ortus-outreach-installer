// The local half of the adaptive check cadence.
//
// Ported from the engine's campaign-monitor.js so a campaign moved onto the
// operator's Mac keeps backing off instead of silently returning to hourly
// forever. Same thresholds, same cap, same critical property: the cap must never
// hand back a cadence SHORTER than the operator's own interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCadenceMin, nextEmptyStreak } from '../src/monitoring-cadence.js';

test('a campaign still finding acceptances is never slowed', () => {
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 0 }), 60);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 2 }), 60);
});

test('three empty sweeps double it, six quadruple it', () => {
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 3 }), 120);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 5 }), 120);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 6 }), 240);
  assert.equal(checkCadenceMin({ baseMin: 60, emptyStreak: 99 }), 240);
});

test('the cap never returns LESS than the operator asked for', () => {
  // The bug this exact assertion caught in the engine: a 6h campaign was being
  // checked MORE often for going quiet.
  assert.equal(checkCadenceMin({ baseMin: 360, emptyStreak: 3 }), 360);
  assert.equal(checkCadenceMin({ baseMin: 720, emptyStreak: 6 }), 720);
});

test('a missing or nonsense base falls back to hourly', () => {
  assert.equal(checkCadenceMin({ emptyStreak: 0 }), 60);
  assert.equal(checkCadenceMin({ baseMin: 0, emptyStreak: 9 }), 240);
});

test('any acceptance resets the streak, otherwise it advances', () => {
  assert.equal(nextEmptyStreak({ newlyAccepted: 1, current: 8 }), 0);
  assert.equal(nextEmptyStreak({ newlyAccepted: 0, current: 8 }), 9);
  assert.equal(nextEmptyStreak({ current: -3 }), 1, 'a corrupt streak never goes negative');
});
