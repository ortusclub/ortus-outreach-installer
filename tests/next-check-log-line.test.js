// One sentence for "when is the next check", written the same way by every
// writer on both machines.
//
// The app had four phrasings of its own and the cloud engine had a fifth, so
// three cards in the identical state read three different headlines, and each
// new phrasing needed its own banner rule before it could be understood at all.
// Operator, 2026-08-28: "why do they say 2 different things despite them being
// in the exact same state?!"
//
// The engine's line (campaign-runtime.js) is the reference:
//   ⏱ Next check 2026-08-28 16:08 UTC · nothing happens until then, the campaign stays running.
//
// Run: node --test tests/next-check-log-line.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextCheckLogLine } from '../src/campaign.js';
import { latestBannerEvent } from '../public/js/live-log-banner.mjs';

const ENGINE_LINE = '⏱ Next check 2026-08-28 16:08 UTC · nothing happens until then, the campaign stays running.';

test('the app writes the engine\'s sentence, byte for byte', () => {
  assert.equal(nextCheckLogLine(new Date('2026-08-28T16:08:00.000Z')), ENGINE_LINE);
  assert.equal(nextCheckLogLine('2026-08-28T16:08:43.866Z'), ENGINE_LINE,
    'seconds are dropped, exactly as the engine drops them');
});

test('a time it cannot read produces no line at all, never a broken one', () => {
  assert.equal(nextCheckLogLine('not a date'), '');
  assert.equal(nextCheckLogLine(null), '');
});

// The point of the shared sentence: one banner rule understands every writer.
test('the shared sentence reads as the one monitoring state', () => {
  const e = latestBannerEvent([`[2026-08-28T15:10:20.000Z] ${ENGINE_LINE}`]);
  assert.equal(e.kind, 'check-waiting');
  assert.equal(e.headline, 'Waiting for the next acceptance check');
  assert.equal(e.explanation, 'Nothing needs to be done now.');
});

// It has to survive being the last line after a finished sweep, which is where
// it actually lands: the account results come first, the schedule closes it.
test('it wins the banner over the account lines a sweep leaves behind', () => {
  const e = latestBannerEvent([
    '[2026-08-28T15:09:50.000Z] 📡 [carlos@virtualroundtable.com] Launching browser…',
    '[2026-08-28T15:10:01.000Z] 📡 [carlos@virtualroundtable.com] Sweeping recent connections…',
    '[2026-08-28T15:10:20.000Z] 🛏 Nobody has accepted carlos@virtualroundtable.com\'s 135 outstanding invitations yet. 42 rows refreshed as still waiting.',
    `[2026-08-28T15:10:20.000Z] ${ENGINE_LINE}`,
  ]);
  assert.equal(e.kind, 'check-waiting');
  assert.equal(e.headline, 'Waiting for the next acceptance check');
});
