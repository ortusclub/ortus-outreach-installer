import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMonitoringResume } from '../src/monitoring-resume-plan.js';
const now = Date.parse('2026-09-09T12:00:00Z');
const fixture = () => ({ executionId: 'run-a', taskCampaignId: 'legacy-singleton', campaignRunId: 'owner-a',
  mode: 'connect_and_introduce', state: 'idle', running: false, sheetUrl: 'saved-sheet',
  participatingProfileIds: ['sender'], sendingEndedAt: '2026-09-08T12:00:00Z',
  monitoringUntil: '2026-09-15T12:00:00Z', checkIntervalMinutes: 60,
  processed: { recipient: { action: 'interrupted' } }, dailyLimit: 2 });
test('monitoring plan is read-only, preserves expiry, and does not start sending', () => {
  const s = fixture(), before = structuredClone(s);
  const p = planMonitoringResume(s, { executionId: 'run-a' }, now);
  assert.deepEqual(s, before);
  assert.equal(p.nextCheckAt, '2026-09-09T13:00:00.000Z');
  assert.equal(Date.parse(p.monitoringUntil), Date.parse(s.monitoringUntil));
  assert.deepEqual(Object.keys(p.patch).sort(), ['autoChecksEnabled', 'nextCheckAt', 'state']);
});
test('unsupported types and incomplete, expired, busy or unowned snapshots fail closed', () => {
  for (const patch of [{ mode: 'connect_only' }, { mode: 'follower_growth' }, { running: true },
    { paused: true }, { pauseRequested: true }, { monitoringCheckInProgress: true },
    { state: 'needs_review' }, { campaignRunId: '' }, { participatingProfileIds: [] },
    { participatingProfileIds: [null] }, { sheetUrl: '' }, { sendingEndedAt: null },
    { monitoringUntil: null }, { monitoringUntil: '2026-09-09T11:00:00Z' },
    { monitoringUntil: '2026-09-09T12:30:00Z' }]) {
    assert.throws(() => planMonitoringResume({ ...fixture(), ...patch }, { executionId: 'run-a' }, now));
  }
  assert.throws(() => planMonitoringResume(fixture(), { executionId: 'other-run' }, now));
});
test('active monitoring preserves its future schedule; disabled monitoring is distinguished', () => {
  const s = { ...fixture(), mode: 'connect_and_message', state: 'monitoring', nextCheckAt: '2026-09-09T12:40:00Z' };
  assert.equal(planMonitoringResume(s, { executionId: 'run-a' }, now).alreadyActive, true);
  const p = planMonitoringResume({ ...s, autoChecksEnabled: false }, { executionId: 'run-a' }, now);
  assert.equal(p.alreadyActive, false);
  assert.equal(p.nextCheckAt, '2026-09-09T12:40:00.000Z');
  assert.throws(() => planMonitoringResume({ ...s, nextCheckAt: null }, { executionId: 'run-a' }, now), /schedule is missing/);
});
