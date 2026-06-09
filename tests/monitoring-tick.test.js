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
