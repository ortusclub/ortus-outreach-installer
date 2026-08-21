// The local half of the adaptive check cadence.
//
// Ported from the engine's campaign-monitor.js so a campaign moved onto the
// operator's Mac keeps backing off instead of silently returning to hourly
// forever. Same thresholds, same cap, same critical property: the cap must never
// hand back a cadence SHORTER than the operator's own interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCadenceMin, nextEmptyStreak, summarizeMonitoringSweep } from '../src/monitoring-cadence.js';

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

// Review finding 1: a sweep where every account failed (needs re-login,
// launch failure, abort) must not be indistinguishable from "looked and
// found nobody" — that silently stretches a broken campaign to 4h with
// nothing flagged.
test('a sweep where nothing actually looked does not count as empty', () => {
  assert.deepEqual(summarizeMonitoringSweep([]), { looked: false, newlyAccepted: 0 });
  assert.deepEqual(
    summarizeMonitoringSweep([{ ok: false, error: 'launch failed' }]),
    { looked: false, newlyAccepted: 0 },
  );
  // ok:true but bulkCheckConnections itself failed mid-flight — still not a look.
  assert.deepEqual(
    summarizeMonitoringSweep([{ ok: true, error: 'session-expired', matched: 0, freshConnected: 0 }]),
    { looked: false, newlyAccepted: 0 },
  );
});

test('a completed sweep with genuinely nobody new counts as looked, empty', () => {
  assert.deepEqual(
    summarizeMonitoringSweep([{ ok: true, matched: 0, freshConnected: 0 }]),
    { looked: true, newlyAccepted: 0 },
  );
});

// Review finding 2: `matched` also counts pre-existing 1st-degree
// connections re-queued for a retried intro (not a new acceptance this
// sweep). Only `freshConnected` may drive the streak reset.
test('matched and freshConnected diverge on a re-queued already-connected lead', () => {
  const results = [{ ok: true, matched: 1, freshConnected: 0 }];
  assert.deepEqual(summarizeMonitoringSweep(results), { looked: true, newlyAccepted: 0 });
});

test('mixed sweep: one account looked and found one, another failed outright', () => {
  const results = [
    { ok: true, matched: 1, freshConnected: 1 },
    { ok: false, error: 'needs-login' },
  ];
  assert.deepEqual(summarizeMonitoringSweep(results), { looked: true, newlyAccepted: 1 });
});
