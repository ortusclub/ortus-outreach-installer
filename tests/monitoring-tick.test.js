import { test } from 'node:test';
import assert from 'node:assert';
import { _setTestState, tickMonitoringNow, getCampaignState } from '../src/campaign.js';

test('tickMonitoringNow does nothing when state is not monitoring', async () => {
  _setTestState({ state: 'idle', nextCheckAt: new Date(Date.now() - 60_000).toISOString() });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('tickMonitoringNow does nothing when nextCheckAt is in the future', async () => {
  _setTestState({
    state: 'monitoring',
    nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: () => { fired = true; } });
  assert.equal(fired, false);
});

test('tickMonitoringNow fires when overdue and reschedules by the EXACT cadence (no floor)', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30, // set directly (bypasses intake clamp) to prove the reschedule does NOT floor
    logs: [],
  });
  let fired = false;
  await tickMonitoringNow({ _testStub: async () => { fired = true; } });
  assert.equal(fired, true);
  const s = getCampaignState();
  const nextMs = new Date(s.nextCheckAt).getTime();
  // No 60-min floor anymore: a 30-min value reschedules ~30 min out, not ~60.
  assert.ok(nextMs > Date.now() + 29 * 60_000, 'nextCheckAt should be ~30 min out');
  assert.ok(nextMs <= Date.now() + 31 * 60_000, 'nextCheckAt should not exceed 30 min + slack');
});

// Review finding 6 — the real (non-stub) tick path was never exercised, and
// it is the only path that runs the adaptive-cadence wiring: _testStub
// replaces the whole check call, so campaign._lastCheckNewlyAccepted is
// never set under it. participatingProfileIds=[] drives the REAL
// runMonitoringCheckAll() → it loops zero accounts → a genuine "nothing
// looked" sweep, with no browser/network involved.
test('a zero-account sweep is actionable and retries in ten minutes without changing the base cadence', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 60,
    emptyCheckStreak: 6, // already stretched — x4 → 240min
    participatingProfileIds: [],
    logs: [],
  });
  await tickMonitoringNow(); // no _testStub — real runMonitoringCheckAll()
  const s = getCampaignState();
  // Finding 1: zero accounts swept = nothing looked = streak untouched.
  assert.equal(s.emptyCheckStreak, 6, 'a sweep that looked at nobody must not advance the streak');
  // Finding 6 / the planted compounding bug: the operator's OWN setting must
  // survive the tick unchanged — only the (separate) status payload may show
  // the stretched effective value.
  assert.equal(s.checkIntervalMinutes, 60, 'the base cadence must never be overwritten with the stretched value');
  assert.match(s.monitorCheckError, /no monitoring accounts are configured/i);
  // An incomplete sweep retries soon instead of disappearing for the stretched cadence.
  const nextMs = new Date(s.nextCheckAt).getTime();
  assert.ok(nextMs > Date.now() + 9 * 60_000, 'nextCheckAt should be ~10 min out');
  assert.ok(nextMs <= Date.now() + 11 * 60_000, 'nextCheckAt should not exceed 10 min + slack');
});

test('tickMonitoringNow does not reschedule when state changes during fire', async () => {
  const past = new Date(Date.now() - 1000);
  _setTestState({
    state: 'monitoring',
    nextCheckAt: past.toISOString(),
    monitoringUntil: new Date(Date.now() + 86400_000).toISOString(),
    checkIntervalMinutes: 30,
    logs: [],
  });
  const originalNext = past.toISOString();
  await tickMonitoringNow({
    _testStub: async () => { _setTestState({ state: 'done' }); },
  });
  const s = getCampaignState();
  assert.equal(s.nextCheckAt, originalNext, 'nextCheckAt should NOT be advanced after state changed away from monitoring');
});
