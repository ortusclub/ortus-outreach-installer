import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionToMonitoring } from '../src/campaign-state-transitions.js';

test('transitionToMonitoring: mode != connect_and_introduce → returns unchanged campaign with state=done', () => {
  const campaign = { id: 'c1', mode: 'connect_only', state: 'running', logs: [] };
  const out = transitionToMonitoring(campaign, { now: new Date('2026-05-13T01:31:45Z'), participatingProfileIds: ['p1'] });
  assert.equal(out.state, 'done');
  assert.equal(out.sendingEndedAt, undefined);
});

test('transitionToMonitoring: connect_and_introduce → state=monitoring with all fields populated', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const now = new Date('2026-05-13T01:31:45Z');
  const out = transitionToMonitoring(campaign, { now, participatingProfileIds: ['p1', 'p2'] });
  assert.equal(out.state, 'monitoring');
  assert.equal(out.sendingEndedAt, now.toISOString());
  assert.equal(out.monitoringUntil, '2026-05-20T01:31:45.000Z');
  assert.equal(out.nextCheckAt, '2026-05-13T02:31:45.000Z');
  assert.deepEqual(out.participatingProfileIds, ['p1', 'p2']);
});

test('transitionToMonitoring: connect_and_message (CC+DM) → state=monitoring like CC+IC', () => {
  // v2.62 symmetry: CC+DM runs a phase-2 monitoring loop (runAutoDms) just
  // like CC+IC runs runAutoIntros. The caller (campaign.js) and the monitoring
  // tick both route connect_and_message — this helper must not drop it to 'done'.
  const campaign = { id: 'c1', mode: 'connect_and_message', state: 'running', logs: [] };
  const now = new Date('2026-05-13T01:31:45Z');
  const out = transitionToMonitoring(campaign, { now, participatingProfileIds: ['p1', 'p2'] });
  assert.equal(out.state, 'monitoring');
  assert.equal(out.sendingEndedAt, now.toISOString());
  assert.equal(out.monitoringUntil, '2026-05-20T01:31:45.000Z');
  assert.deepEqual(out.participatingProfileIds, ['p1', 'p2']);
});

test('transitionToMonitoring is idempotent — calling twice does not advance times', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const now1 = new Date('2026-05-13T01:31:45Z');
  const once = transitionToMonitoring(campaign, { now: now1, participatingProfileIds: ['p1'] });
  const now2 = new Date('2026-05-13T03:00:00Z');
  const twice = transitionToMonitoring(once, { now: now2, participatingProfileIds: ['p1'] });
  assert.equal(twice.sendingEndedAt, once.sendingEndedAt);
  assert.equal(twice.monitoringUntil, once.monitoringUntil);
});

test('transitionToMonitoring: empty participatingProfileIds → state=done (no accounts ever sent)', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const out = transitionToMonitoring(campaign, { now: new Date(), participatingProfileIds: [] });
  assert.equal(out.state, 'done');
});

test('transitionToMonitoring appends a "Monitoring started" log line with next-check time in local TZ', () => {
  const campaign = { id: 'c1', mode: 'connect_and_introduce', state: 'running', logs: [] };
  const now = new Date('2026-05-13T01:31:45Z');
  const out = transitionToMonitoring(campaign, { now, participatingProfileIds: ['p1'] });
  const last = out.logs[out.logs.length - 1];
  assert.match(last, /Monitoring started/);
  const expectedNextCheck = new Date(now.getTime() + 60 * 60 * 1000);
  const hh = String(expectedNextCheck.getHours()).padStart(2, '0');
  const mm = String(expectedNextCheck.getMinutes()).padStart(2, '0');
  assert.ok(last.includes(`${hh}:${mm}`), `expected log to contain "${hh}:${mm}", got: ${last}`);
});
