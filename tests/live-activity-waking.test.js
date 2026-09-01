// The hero's three states, derived once and shared by the campaign card, the
// dashboard strip and the log. Pure so it tests without a DOM.
//
// 'waking' is the state that did not exist on 2026-07-30: a check was due, no
// worker had claimed it, and the UI showed a countdown reading "now" for 45
// minutes. Wake-on-demand makes that gap routine (65-98s pod boot), so it needs
// to be visible and honest about overrunning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorHeroState } from '../public/js/live-activity.mjs';

const NOW = new Date('2026-07-30T15:06:25.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();

test('counting: the task is pending but not due yet', () => {
  const s = { monitorTaskStatus: 'pending', monitorTaskDueAt: iso(NOW + 60_000) };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'counting', overrun: false });
});

test('waking: the task is due and no worker has claimed it', () => {
  const s = { monitorTaskStatus: 'pending', monitorTaskDueAt: iso(NOW - 5_000) };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'waking', overrun: false });
});

test('waking overruns after 5 minutes', () => {
  const s = { monitorTaskStatus: 'pending', monitorTaskDueAt: iso(NOW - 6 * 60_000) };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'waking', overrun: true });
});

test('checking beats a due task — a claimed row wins', () => {
  const s = {
    monitorTaskStatus: 'claimed', monitorTaskDueAt: iso(NOW - 60_000),
    monitorCheckStartedAt: iso(NOW - 30_000),
  };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'checking', overrun: false });
});

test('checking overruns after 15 minutes', () => {
  // Above the longest real sweep (3m16s), below the 45min monitor reap — so the
  // "auto-recovers" copy is true whenever it is shown.
  const s = { monitorTaskStatus: 'claimed', monitorCheckStartedAt: iso(NOW - 16 * 60_000) };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'checking', overrun: true });
});

test('a new manual request never looks stalled because of the previous completed sweep', () => {
  const s = {
    monitoringCheckInProgress: true,
    monitorCheckStartedAt: new Date(NOW - 60 * 60_000).toISOString(),
    monitorCheckCompletedAt: new Date(NOW - 59 * 60_000).toISOString(),
  };
  assert.deepEqual(monitorHeroState(s, NOW), { state: 'checking', overrun: false });
});

test('the legacy in-progress flag still means checking', () => {
  assert.equal(monitorHeroState({ monitoringCheckInProgress: true }, NOW).state, 'checking');
});

test('a pre-fix engine (no task fields) counts down exactly as today', () => {
  assert.deepEqual(monitorHeroState({}, NOW), { state: 'counting', overrun: false });
  assert.deepEqual(monitorHeroState(null, NOW), { state: 'counting', overrun: false });
});

test('a done task row never reads as a wake', () => {
  const s = { monitorTaskStatus: 'done', monitorTaskDueAt: iso(NOW - 60_000) };
  assert.equal(monitorHeroState(s, NOW).state, 'counting');
});

test('a malformed dueAt falls back to counting rather than a fake wake', () => {
  const s = { monitorTaskStatus: 'pending', monitorTaskDueAt: 'nonsense' };
  assert.equal(monitorHeroState(s, NOW).state, 'counting');
});
