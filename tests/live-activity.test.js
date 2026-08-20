import { test } from 'node:test';
import assert from 'node:assert';
import { buildLiveActivity, pauseAutoStop, PAUSE_MAX_MS } from '../public/js/live-activity.mjs';

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

test('every account capped/benched → says so, never "Working…"', () => {
  // The 2026-08-05 stall: status stayed 'running' with a green dot while the
  // engine logged "No account free right now" every 10 minutes for ten hours.
  const r = buildLiveActivity({
    running: true,
    currentAction: { phase: 'waiting', label: 'Waiting for a free account',
      lead: 'No account free', sub: '1 at the daily limit · 2 parked (throttled / needs login / weekly cap)' },
  });
  assert.equal(r.state, 'waiting');
  assert.equal(r.phase, 'waiting');
  assert.notEqual(r.l1, 'Working…');
  assert.match(r.verb, /free account/i);
  assert.match(r.sub, /daily limit/);
});

// ── The 48h pause deadline ──────────────────────────────────────────────────
// A pause holds the campaign's accounts and freezes its unsent leads, so the
// engine cancels it after 48h. The card has to SAY so at the moment it is
// paused — a rule the operator only discovers when their campaign is gone is
// worse than no rule.

test('a paused cloud campaign says when it will auto-stop', () => {
  const now = Date.parse('2026-08-20T10:00:00Z');
  const r = buildLiveActivity(
    { running: true, paused: true, pausedAt: '2026-08-20T09:00:00Z' }, now,
  );
  assert.equal(r.state, 'paused');
  assert.equal(r.l2, 'auto-stops in 47h · resumes instantly, browsers stay open');
});

test('a local pause makes no promise it cannot keep', () => {
  // No pausedAt: the local pause lives in memory and dies with the app, and
  // nothing enforces 48h for it. The old wording, unchanged.
  const r = buildLiveActivity({ running: true, paused: true });
  assert.equal(r.state, 'paused');
  assert.equal(r.l2, 'resumes instantly · browsers stay open');
});

test('the deadline counts in hours far out, minutes when it is close', () => {
  const at = '2026-08-20T00:00:00Z';
  const T = (iso) => Date.parse(iso);
  assert.equal(pauseAutoStop(at, T('2026-08-20T00:00:00Z')), 'auto-stops in 48h');
  assert.equal(pauseAutoStop(at, T('2026-08-21T23:00:00Z')), 'auto-stops in 1h 0m',
    'under two hours the minutes matter — it is about to happen');
  assert.equal(pauseAutoStop(at, T('2026-08-21T23:30:00Z')), 'auto-stops in 30 min');
});

test('past the deadline it never counts down through zero', () => {
  // The engine cancels on its next tick; a negative countdown would read as a
  // campaign that is still safely paused.
  const r = pauseAutoStop('2026-08-18T00:00:00Z', Date.parse('2026-08-20T10:00:00Z'));
  assert.equal(r, 'auto-stopping now — paused too long');
});

test('an unparseable or missing stamp renders nothing, never NaN', () => {
  assert.equal(pauseAutoStop(null), '');
  assert.equal(pauseAutoStop(''), '');
  assert.equal(pauseAutoStop('not a date'), '');
});

test('the app and the engine agree on 48 hours', () => {
  // If these ever diverge the card counts down to a moment nothing acts on.
  assert.equal(PAUSE_MAX_MS, 48 * 60 * 60 * 1000);
});

test('past the deadline the card drops "resumes instantly"', () => {
  // Caught in the sketch: the card read "auto-stopping now — paused too long ·
  // resumes instantly, browsers stay open". It is about to be cancelled, so
  // resuming is the one thing it will not do.
  const r = buildLiveActivity(
    { running: true, paused: true, pausedAt: '2026-08-18T00:00:00Z' },
    Date.parse('2026-08-20T10:00:00Z'),
  );
  assert.equal(r.l2, 'auto-stopping now — paused too long');
  assert.ok(!/resumes instantly/.test(r.l2));
});
