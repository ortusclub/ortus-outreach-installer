// monitorHeroView — the single source of truth for what the monitoring hero
// DISPLAYS (big value + caption + state class).
//
// Why it exists: the expanded board card is a cloneNode(true) of the live card #2
// DOM, so it inherits card #2's caption text and state class at the moment it is
// cloned. Its own filler (_fillVjMonitorHero) refreshed ONLY the number. So when
// card #2 happened to be mid-sweep, the board card froze at caption "now" in
// checking-gold while its countdown ticked on beside it — operator screenshot
// 2026-07-31 showing "52:05" in gold next to "NOW", two states at once.
//
// The invariant these tests pin: count, cap and state always come from ONE
// decision, so no renderer can update one without the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorHeroView } from '../public/js/live-activity.mjs';

const fmt = (ms) => `T-${Math.round(ms / 1000)}`;
const NOW = Date.parse('2026-07-31T13:28:56.000Z');

test('counting: countdown value with the countdown caption', () => {
  const v = monitorHeroView(
    { nextCheckAt: '2026-07-31T14:20:07.000Z', monitorTaskStatus: 'pending', monitorTaskDueAt: '2026-07-31T14:20:07.000Z' },
    fmt, NOW,
  );
  assert.equal(v.state, 'counting');
  assert.equal(v.cap, 'until next check');
  assert.equal(v.count, fmt(Date.parse('2026-07-31T14:20:07.000Z') - NOW));
});

test('checking: the caption is never left on a countdown label', () => {
  // The exact production state behind the screenshot: sweep body finished, task
  // still claimed while the sheet sync runs, next_check_at already advanced.
  const v = monitorHeroView(
    {
      nextCheckAt: '2026-07-31T14:20:07.000Z',
      monitorTaskStatus: 'claimed',
      monitorTaskDueAt: '2026-07-31T13:20:07.000Z',
      monitorCheckStartedAt: '2026-07-31T13:20:10.000Z',
    },
    fmt, NOW,
  );
  assert.equal(v.state, 'checking');
  assert.equal(v.count, 'CHECKING');
  assert.equal(v.cap, 'now');
});

test('waking: due but unclaimed', () => {
  const v = monitorHeroView(
    { nextCheckAt: '2026-07-31T13:20:07.000Z', monitorTaskStatus: 'pending', monitorTaskDueAt: '2026-07-31T13:28:00.000Z' },
    fmt, NOW,
  );
  assert.equal(v.state, 'waking');
  assert.equal(v.count, 'WAKING');
  assert.equal(v.cap, 'sweeping in ~2 min');
});

test('the caption never contradicts the value', () => {
  // The screenshot bug in one assertion: a numeric countdown must never be shown
  // under a caption that claims a sweep is happening now, and vice versa.
  const cases = [
    { nextCheckAt: '2026-07-31T14:20:07.000Z', monitorTaskStatus: 'pending', monitorTaskDueAt: '2026-07-31T14:20:07.000Z' },
    { nextCheckAt: '2026-07-31T14:20:07.000Z', monitorTaskStatus: 'claimed', monitorTaskDueAt: '2026-07-31T13:20:07.000Z', monitorCheckStartedAt: '2026-07-31T13:20:10.000Z' },
    { nextCheckAt: '2026-07-31T13:20:07.000Z', monitorTaskStatus: 'pending', monitorTaskDueAt: '2026-07-31T13:28:00.000Z' },
    {},
  ];
  for (const s of cases) {
    const v = monitorHeroView(s, fmt, NOW);
    const isWord = v.count === 'CHECKING' || v.count === 'WAKING';
    assert.equal(
      isWord, v.state !== 'counting',
      `a word value must pair with a non-counting state (got count=${v.count} state=${v.state})`,
    );
    assert.equal(
      v.cap === 'until next check', v.state === 'counting',
      `the countdown caption must appear only while counting (got cap=${v.cap} state=${v.state})`,
    );
  }
});

test('overrun captions replace the estimate rather than repeating it', () => {
  const stalled = monitorHeroView(
    { monitorTaskStatus: 'claimed', monitorCheckStartedAt: '2026-07-31T12:00:00.000Z' }, fmt, NOW,
  );
  assert.equal(stalled.state, 'checking');
  assert.match(stalled.cap, /stalled/);

  const slowWake = monitorHeroView(
    { monitorTaskStatus: 'pending', monitorTaskDueAt: '2026-07-31T13:00:00.000Z' }, fmt, NOW,
  );
  assert.equal(slowWake.state, 'waking');
  assert.doesNotMatch(slowWake.cap, /~2 min/, 'must not keep promising 2 minutes once it is late');
});

test('no status at all → a plain dash, never a fabricated wake', () => {
  const v = monitorHeroView(null, fmt, NOW);
  assert.equal(v.state, 'counting');
  assert.equal(v.count, '—');
  assert.equal(v.cap, 'until next check');
});

test('an unslowed campaign keeps the caption it has always had', () => {
  // The regression lock for the whole feature: a campaign that never slows down
  // must not gain a single new word.
  const v = monitorHeroView(
    { nextCheckAt: new Date(Date.now() + 600000).toISOString(),
      checkIntervalMinutes: 60, checkIntervalBaseMinutes: 60 },
    () => '10:00'
  );
  assert.equal(v.cap, 'until next check');
  assert.equal(v.state, 'counting');
});

test('a slowed campaign names its cadence in the caption', () => {
  const v = monitorHeroView(
    { nextCheckAt: new Date(Date.now() + 600000).toISOString(),
      checkIntervalMinutes: 240, checkIntervalBaseMinutes: 60, emptyCheckStreak: 9 },
    () => '3:41:08'
  );
  assert.equal(v.cap, 'next check · slowed to 4h');
  assert.equal(v.count, '3:41:08', 'the number is still the countdown');
});

test('a slowed campaign mid-sweep says CHECKING, not a cadence', () => {
  // The number and its caption must come from the SAME decision — the drift this
  // function exists to prevent. A sweep in flight outranks the slowdown.
  const v = monitorHeroView(
    { monitorTaskStatus: 'claimed', checkIntervalMinutes: 240, checkIntervalBaseMinutes: 60 },
    () => 'x'
  );
  assert.equal(v.count, 'CHECKING');
  assert.equal(v.cap, 'now');
});

test('a 30-minute campaign slowed to an hour says so in minutes-or-hours form', () => {
  const v = monitorHeroView(
    { nextCheckAt: new Date(Date.now() + 600000).toISOString(),
      checkIntervalMinutes: 120, checkIntervalBaseMinutes: 30, emptyCheckStreak: 6 },
    () => '1:02:03'
  );
  assert.equal(v.cap, 'next check · slowed to 2h');
});
