// The cloud throughput headline.
//
// The local forecast divides leads by "~50 leads/hr × parallel browsers" and
// prints a wall-clock finish — "2H 6M · finishes 18:15". None of that describes
// the VM: the work is spread over autoscaled pods, the parallel-accounts knob is
// never sent to the engine at all, and the shared account lock already limits
// each LinkedIn account to one action at a time across the fleet. The real bound
// is the daily send cap the engine enforces per account per day.
//
// So these tests pin the one property that matters: a cloud campaign is
// described in DAYS OF CAPACITY, never in hours of wall-clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloudThroughputView, daysNeeded } from '../public/js/throughput-view.mjs';

const FRI_31_JUL = Date.parse('2026-07-31T14:00:00Z');
const fmtDate = (d) => d.toISOString().slice(0, 10);

test('the operator screenshot case: 6 accounts × 35, 200 leads', () => {
  const v = cloudThroughputView({ accounts: 6, dailyLimit: 35, leadsInSheet: 200, now: FRI_31_JUL, fmtDate });
  assert.equal(v.actions, '210', '6 × 35');
  assert.equal(v.actionsSub, '6 accounts × 35 per day');
  assert.equal(v.duration, '210 / day');
  assert.equal(v.finishK, '200 leads');
  assert.equal(v.finish, '~1 day', 'not "2H 6M"');
  assert.equal(v.finishSub, 'done by 2026-08-01');
});

test('never reports an hour-based duration', () => {
  // The specific regression: any "Nh Nm" or a HH:MM clock time means the local
  // wall-clock model leaked into the cloud panel.
  const cases = [
    { accounts: 6, dailyLimit: 35, leadsInSheet: 200 },
    { accounts: 1, dailyLimit: 50, leadsInSheet: 20 },
    { accounts: 3, dailyLimit: 35, leadsInSheet: 5000 },
    { accounts: 2, dailyLimit: 50, leadsInSheet: null },
    { accounts: 0, dailyLimit: 50, leadsInSheet: 200 },
  ];
  for (const c of cases) {
    const v = cloudThroughputView({ ...c, now: FRI_31_JUL, fmtDate });
    for (const field of [v.duration, v.finish]) {
      assert.doesNotMatch(field, /\d+\s*h\s*\d+\s*m/i, `hour-based duration leaked: ${field}`);
      assert.doesNotMatch(field, /^\d{1,2}:\d{2}$/, `clock time leaked: ${field}`);
    }
  }
});

test('a multi-day sheet reports whole days', () => {
  // 5000 leads at 3 × 35 = 105/day → 48 days.
  const v = cloudThroughputView({ accounts: 3, dailyLimit: 35, leadsInSheet: 5000, now: FRI_31_JUL, fmtDate });
  assert.equal(v.duration, '105 / day');
  assert.equal(v.finish, '~48 days');
  assert.equal(v.finishSub, 'done by 2026-09-17');
});

test('a sheet smaller than one day of capacity still reads ~1 day', () => {
  const v = cloudThroughputView({ accounts: 6, dailyLimit: 50, leadsInSheet: 12, now: FRI_31_JUL, fmtDate });
  assert.equal(v.finish, '~1 day');
});

test('no sheet previewed → capacity stated, no finish promised', () => {
  const v = cloudThroughputView({ accounts: 2, dailyLimit: 50, leadsInSheet: null, now: FRI_31_JUL, fmtDate });
  assert.equal(v.actions, '100');
  assert.equal(v.duration, '100 / day');
  assert.equal(v.finish, '—', 'must not invent a date from an unknown lead count');
  assert.equal(v.finishSub, 'preview the sheet to forecast');
});

test('no accounts selected → everything dashes', () => {
  const v = cloudThroughputView({ accounts: 0, dailyLimit: 50, leadsInSheet: 200, now: FRI_31_JUL, fmtDate });
  assert.equal(v.actions, '—');
  assert.equal(v.duration, '—');
  assert.equal(v.finish, '—');
  assert.match(v.actionsSub, /select accounts/);
});

test('singular account wording', () => {
  const v = cloudThroughputView({ accounts: 1, dailyLimit: 50, leadsInSheet: 20, now: FRI_31_JUL, fmtDate });
  assert.equal(v.actionsSub, '1 account × 50 per day');
});

test('daysNeeded rounds up and is safe on zero', () => {
  assert.equal(daysNeeded(200, 210), 1);
  assert.equal(daysNeeded(211, 210), 2);
  assert.equal(daysNeeded(0, 210), 0);
  assert.equal(daysNeeded(200, 0), 0, 'no accounts → no division by zero');
});
