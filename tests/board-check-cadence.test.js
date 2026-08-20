// The board (card #1 strip + its cloned card #2) must show the adaptive check
// cadence, not just the campaign tab.
//
// 2026-08-20 whole-branch review, finding 3: statusFromItem is an explicit
// WHITELIST, and it dropped checkIntervalBaseMinutes + emptyCheckStreak. The app
// mapped both onto the board item, they died in the whitelist, checkSlowdown()
// returned null on the board and the strip read
//   "5 accounts · checks every 4h · nothing running right now"
// — a temporary slowdown presented as the operator's own setting.
//
// The app must NOT gain its own copy of the cadence table (no 3/6 thresholds, no
// 240 cap). Slowed is decided solely by effective > base.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusFromItem } from '../public/js/vjcard.mjs';
import { buildLiveActivity, checkSlowdown, stripCadence } from '../public/js/live-activity.mjs';

const boardItem = (over = {}) => ({
  where: 'cloud', id: 'c1', bucket: 'running', monitoring: true,
  accounts: 5, profileIds: ['a', 'b', 'c', 'd', 'e'], sent: 10, total: 40, autoChecksEnabled: true,
  checkIntervalMinutes: 60, checkIntervalBaseMinutes: 60, emptyCheckStreak: 0,
  ...over,
});
const SLOWED = { checkIntervalMinutes: 240, checkIntervalBaseMinutes: 60, emptyCheckStreak: 9 };

// ── statusFromItem carries the two fields through the whitelist ──
test('statusFromItem passes the base cadence and the streak through', () => {
  const s = statusFromItem(boardItem(SLOWED));
  assert.equal(s.checkIntervalMinutes, 240);
  assert.equal(s.checkIntervalBaseMinutes, 60);
  assert.equal(s.emptyCheckStreak, 9);
  assert.deepEqual(checkSlowdown(s), { eff: 240, base: 60, streak: 9 },
    'if this is null the board cannot know the campaign slowed at all');
});

test('a board item with no base cadence is NOT reported as slowed', () => {
  // A local campaign set to 2h carries no base at all. Defaulting the base to 60
  // would invent a slowdown out of the operator's own setting.
  const s = statusFromItem({ where: 'local', bucket: 'running', monitoring: true, checkIntervalMinutes: 120 });
  assert.equal(s.checkIntervalBaseMinutes, 120);
  assert.equal(checkSlowdown(s), null);
});

test('a board item with no cadence fields at all is not slowed', () => {
  const s = statusFromItem({ where: 'cloud', bucket: 'running', monitoring: true });
  assert.equal(s.checkIntervalMinutes, 60);
  assert.equal(s.checkIntervalBaseMinutes, 60);
  assert.equal(s.emptyCheckStreak, 0);
  assert.equal(checkSlowdown(s), null);
});

// ── the board's live line, built from that status ──
test("the board's live line says the checks slowed, and what un-slows them", () => {
  const a = buildLiveActivity(statusFromItem(boardItem(SLOWED)));
  assert.equal(a.l1, 'Quiet — checking less often');
  assert.equal(a.l2, 'nothing accepted in the last 9 checks · hourly again as soon as one lands');
});

test('REGRESSION LOCK: an unslowed board campaign reads exactly as it always has', () => {
  const a = buildLiveActivity(statusFromItem(boardItem()));
  assert.equal(a.l1, 'Waiting for next check');
  assert.equal(a.l2, '5 accounts · checks every 1h · nothing running right now');
});

// ── the collapsed strip's one-line summary ──
test('stripCadence: not slowed → the exact wording the strip has always printed', () => {
  assert.deepEqual(stripCadence(boardItem()), { label: 'every', value: '60m' });
  assert.deepEqual(stripCadence(boardItem({ checkIntervalMinutes: 30, checkIntervalBaseMinutes: 30 })),
    { label: 'every', value: '30m' });
  assert.deepEqual(stripCadence({}), { label: 'every', value: '60m' }, 'no fields → hourly, not 0m');
});

test('stripCadence: slowed → the hero caption\'s words, never "every 4h"', () => {
  assert.deepEqual(stripCadence(boardItem(SLOWED)), { label: 'slowed to', value: '4h' });
  // A 30-minute operator slowed to 60 reads in their own units, from the shared
  // cadenceLabel — the app carries no table of its own.
  assert.deepEqual(
    stripCadence({ checkIntervalMinutes: 60, checkIntervalBaseMinutes: 30, emptyCheckStreak: 4 }),
    { label: 'slowed to', value: '1h' },
  );
});
