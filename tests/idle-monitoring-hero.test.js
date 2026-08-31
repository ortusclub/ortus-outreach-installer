// A campaign that stopped sending and kept checking drew a LIVE SENDING card.
//
// Reported 2026-08-28 with a screenshot: header badge "MONITORING", hero
// "SENDER BROWSER CLOSED", step strip "Campaign running · Sender turn complete
// · Browser closed · Next account selecting" — all of it built from the newest
// line in the log, which was the previous day's last send. The engine was
// sending the right thing the whole time ("Waiting for the next acceptance
// check"); the card overwrote it with the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heroFollowsLog } from '../public/js/vjcard.mjs';
import { latestBannerEvent } from '../public/js/live-log-banner.mjs';

test('idle monitoring ignores a stale sending event', () => {
  assert.equal(heroFollowsLog('sender-browser-closed', true), false);
  assert.equal(heroFollowsLog('sending-progress', true), false);
  assert.equal(heroFollowsLog('sender-backoff', true), false);
});

test('a sweep that is actually happening still drives the hero', () => {
  // Not idle: these events are happening NOW, so the log stays in charge —
  // that is the whole point of following the log.
  assert.equal(heroFollowsLog('account-checking', false), true);
  assert.equal(heroFollowsLog('introduction-confirmed', false), true);
  assert.equal(heroFollowsLog('sender-browser-closed', false), true);
});

// This assertion used to be the exact opposite, and the operator's screenshot
// proved it wrong: with 'check-complete' allowed to drive an idle card, the
// finished sweep rewrote the phase to 'checking' and the card sat on FINISHED
// CHECKING ALL AVAILABLE ACCOUNTS, countdown replaced by a check-progress
// panel, for the whole hour until the next sweep (2026-08-28). A finished check
// is as much a past event as a finished send.
test('a FINISHED check does not own the idle gap either', () => {
  assert.equal(heroFollowsLog('check-complete', true), false);
  assert.equal(heroFollowsLog('account-checked', true), false);
  assert.equal(heroFollowsLog('local-browser-starting', true), false);
});

// What the card SHOULD show between checks is the schedule, and that is a log
// line too ("Monitoring active · next check at 17:08"). It must stay in charge,
// or the idle gap has nothing to say at all.
test('the next-check line still owns the idle gap', () => {
  assert.equal(heroFollowsLog('check-waiting', true), true);
  assert.equal(heroFollowsLog('sending-paused-monitoring', true), true);
  assert.equal(heroFollowsLog('', true), true);
});

// An incomplete check is unfinished business: the operator has an account to
// fix, and hiding that behind a calm countdown loses the only warning they get.
test('a check that ended badly keeps the card', () => {
  assert.equal(heroFollowsLog('check-error', true), true);
});

// The bug was not that the rule was wrong, it was that the rule was asked too
// late: the event had already rewritten the phase to 'sending', so a check on
// the rendered phase could never fire. Hence monitoringIdle, which is durable.
test('the answer does not depend on the phase the event itself would set', () => {
  assert.equal(heroFollowsLog('sender-browser-closed', true), false);
});

// Three sentences for one state. After a restart the log says "Monitoring
// resumed · next check at 17:08"; after a handover, "Monitoring moved to this
// Mac · next check Fri, 28 Aug, 17:12 (every 60 min)". Neither matched, so both
// fell through to the generic event mapper and one card read MONITORING RESUMED
// beside two reading WAITING FOR THE NEXT ACCEPTANCE CHECK. Operator, 2026-08-28:
// "why is only ONE showing this and the others NOT".
test('every way the engine states the schedule reads as one state', () => {
  const now = new Date('2026-08-28T15:00:00.000Z');
  const of = (line) => latestBannerEvent([`[2026-08-28T15:00:00.000Z] ${line}`], { now });

  const resumed = of('🛏 Monitoring resumed · next check at 17:08');
  assert.equal(resumed.kind, 'check-waiting');
  assert.equal(resumed.headline, 'Waiting for the next acceptance check');

  const moved = of('🛏 Monitoring moved to this Mac · next check Fri, 28 Aug, 17:12 (every 60 min) · monitoring ends Thu, 3 Sept, 14:08');
  assert.equal(moved.kind, 'check-waiting');
  assert.equal(moved.headline, 'Waiting for the next acceptance check');
  // A date with no year used to parse as 2001 and print "mar 28 ago at 17:12".
  assert.match(moved.detail, /^(Today|Tomorrow|\w{3} \d+ \w{3}) at \d{2}:\d{2}$/);
  assert.doesNotMatch(moved.detail, /every 60 min|monitoring ends/,
    'the schedule is the state; the cadence and the window are log detail');
});
