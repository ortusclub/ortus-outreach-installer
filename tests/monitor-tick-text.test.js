// The 1-second countdown tick.
//
// Two surfaces tick a monitoring countdown: the campaign-tab card and every
// expanded board strip. They drifted apart twice — once when only one of them
// knew to leave WAKING alone (a tick overwrote the state word a moment after it
// was rendered), and once when the board's ticker was started from the render
// path and froze the moment the anti-jank skip stopped calling it. The refusals
// now live in one helper; these tests pin them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorTickText } from '../public/js/live-activity.mjs';

const NOW = Date.parse('2026-08-01T13:00:00Z');
// Stand-in for app.js's v3FmtCountdown — same contract: <=0 is "now".
const fmt = (ms) => (ms <= 0 ? 'now' : `${Math.floor(ms / 60000)}m`);

test('counts down toward the next check', () => {
  const at = new Date(NOW + 21 * 60_000).toISOString();
  assert.equal(monitorTickText({ nextCheckAt: at, busy: false, fmtCountdown: fmt, now: NOW }), '21m');
});

test('null means DO NOT TOUCH while the hero shows a state word', () => {
  // The distinction matters: '' or 'now' would blank/overwrite CHECKING or
  // WAKING on the very next tick. Only null leaves the DOM alone.
  const at = new Date(NOW + 21 * 60_000).toISOString();
  assert.equal(monitorTickText({ nextCheckAt: at, busy: true, fmtCountdown: fmt, now: NOW }), null);
});

test('busy wins even with no scheduled check', () => {
  assert.equal(monitorTickText({ nextCheckAt: null, busy: true, fmtCountdown: fmt, now: NOW }), null);
});

test('no next check → a dash, never a countdown to the epoch', () => {
  for (const missing of [null, undefined, '', 0]) {
    assert.equal(monitorTickText({ nextCheckAt: missing, busy: false, fmtCountdown: fmt, now: NOW }), '—');
  }
});

test('an unparseable date is a dash, not NaN', () => {
  assert.equal(monitorTickText({ nextCheckAt: 'not-a-date', busy: false, fmtCountdown: fmt, now: NOW }), '—');
});

test('accepts epoch millis as well as an ISO string', () => {
  const ms = NOW + 5 * 60_000;
  assert.equal(monitorTickText({ nextCheckAt: ms, busy: false, fmtCountdown: fmt, now: NOW }), '5m');
  assert.equal(
    monitorTickText({ nextCheckAt: new Date(ms).toISOString(), busy: false, fmtCountdown: fmt, now: NOW }),
    '5m',
  );
});

test('a check that is already due formats as due — it does not go negative', () => {
  const past = new Date(NOW - 90_000).toISOString();
  assert.equal(monitorTickText({ nextCheckAt: past, busy: false, fmtCountdown: fmt, now: NOW }), 'now');
});
