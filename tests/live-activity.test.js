import { test } from 'node:test';
import assert from 'node:assert';
import { buildLiveActivity } from '../public/js/live-activity.mjs';

// buildLiveActivity turns an /api/campaign/status snapshot into the card's
// "live line" — WHAT the campaign is doing right now. Mode-agnostic: it reads
// the same currentAction/currentProfile/nextCheckAt the backend sends for
// every campaign mode, so connect_only, CC+DM, message_only, etc. all work.

test('monitoring, between checks → "Waiting for next check" (nothing running)', () => {
  const r = buildLiveActivity({
    running: false, state: 'monitoring', monitoringCheckInProgress: false,
    participatingProfileIds: ['a', 'b'], checkIntervalMinutes: 15,
  });
  assert.equal(r.state, 'monitoring');
  assert.equal(r.l1, 'Waiting for next check');
  assert.match(r.l2, /2 accounts/);
  assert.match(r.l2, /15 min/);
});

test('monitoring, a sweep is running → "Checking" state', () => {
  const r = buildLiveActivity({
    running: false, state: 'monitoring', monitoringCheckInProgress: true,
    currentProfile: 'justine.mangera@ortus.solutions',
  });
  assert.equal(r.state, 'checking');
  assert.match(r.l1, /Checking/);
  assert.match(r.l2, /justine\.mangera/);
});

test('sending → surfaces the REAL currentAction label + account · lead', () => {
  const r = buildLiveActivity({
    running: true, state: 'running',
    currentAction: { label: 'Processing lead', account: 'justine@x', lead: 'Catherine' },
  });
  assert.equal(r.state, 'sending');
  assert.equal(r.l1, 'Processing lead');           // not invented — the actual backend label
  assert.equal(r.l2, 'justine@x · Catherine');
});

test('sending with only an account (e.g. "Opening browser")', () => {
  const r = buildLiveActivity({
    running: true, currentAction: { label: 'Opening browser', account: 'justine@x' },
  });
  assert.equal(r.state, 'sending');
  assert.equal(r.l1, 'Opening browser');
  assert.equal(r.l2, 'justine@x');
});

test('paused → paused state', () => {
  const r = buildLiveActivity({ running: true, paused: true });
  assert.equal(r.state, 'paused');
  assert.match(r.l1, /Paused/);
});

test('idle / no campaign → idle state', () => {
  assert.equal(buildLiveActivity({ running: false, state: 'idle' }).state, 'idle');
});

test('null status → idle, never throws', () => {
  assert.equal(buildLiveActivity(null).state, 'idle');
});

test('one account is singular', () => {
  const r = buildLiveActivity({
    running: false, state: 'monitoring', monitoringCheckInProgress: false,
    participatingProfileIds: ['a'], checkIntervalMinutes: 60,
  });
  assert.match(r.l2, /1 account\b/);
  assert.match(r.l2, /1h/);
});

// ── Live phase ticks (v2.160.128) ────────────────────────────────────────────
// The engine now stamps {phase, selecting} per person into cmp:live:<id>, and
// the app maps it onto currentAction. Before this, a cloud send had no
// currentAction at all and every one fell through to the literal "Working…".

test('a sending tick names the person instead of "Working…"', () => {
  const r = buildLiveActivity({
    running: true,
    currentAction: { phase: 'sending', label: 'Sending connection to Sarah Whitfield',
      account: 'matt.adcock@ortus.solutions', lead: 'Sarah Whitfield' },
  });
  assert.equal(r.state, 'sending');
  assert.equal(r.phase, 'sending');
  assert.equal(r.who, 'Sarah Whitfield');
  assert.match(r.l1, /Sarah Whitfield/);
  assert.notEqual(r.l1, 'Working…');
});

test('introducing beats the monitoring branch — intros are not a sweep', () => {
  // Intros fire INSIDE the acceptance sweep, so the campaign is still
  // state:'monitoring'. Reporting that as "Checking for new acceptances…" for
  // the whole intro run is exactly what made intros look like nothing.
  const r = buildLiveActivity({
    running: false, state: 'monitoring', monitoringCheckInProgress: true,
    currentAction: { phase: 'introducing', label: 'Introducing Daniel Okonjo',
      account: 'matt.adcock@ortus.solutions', lead: 'Daniel Okonjo', sub: '2 of 6 accepted connections' },
  });
  assert.equal(r.phase, 'introducing');
  assert.equal(r.who, 'Daniel Okonjo');
  assert.match(r.verb, /introduction/i);
  assert.doesNotMatch(r.l1, /Checking/);
});

test('a checking tick names the account being swept', () => {
  const r = buildLiveActivity({
    running: false, state: 'monitoring', monitoringCheckInProgress: true,
    currentAction: { phase: 'checking', label: 'Checking matt.adcock@ortus.solutions for acceptances',
      account: 'matt.adcock@ortus.solutions', lead: '', sub: 'account 1 of 4' },
  });
  assert.equal(r.phase, 'checking');
  assert.equal(r.state, 'checking');
  assert.match(r.who, /matt\.adcock/);
});

test('paused outranks a stale phase tick', () => {
  const r = buildLiveActivity({
    running: true, paused: true,
    currentAction: { phase: 'sending', lead: 'Sarah Whitfield' },
  });
  assert.equal(r.state, 'paused');
  assert.equal(r.phase, undefined);
});

test('an unknown phase is ignored, not rendered blank', () => {
  const r = buildLiveActivity({
    running: true, currentAction: { phase: 'teleporting', lead: 'Nobody' },
  });
  assert.equal(r.phase, undefined);
  assert.equal(r.l1, 'Working…'); // the old fallback, unchanged
});
