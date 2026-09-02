// Two operator complaints, 2026-08-28.
//
// 1. "I don't like that sometimes they're like 12/13 — would it be 13 in the
//    first place, you know? It should always be based on the daily limit."
//    The pill's denominator was that account's share of the current batch, so
//    it changed every launch and matched nothing else on the card.
//
// 2. A campaign that failed to start offered its restart only as two
//    unlabelled dock glyphs, the first tipped "continue where it left off".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acctPillCount, acctBatchTip, acctRowState, failedStartRetry, vjCardControlsFor } from '../public/js/vjcard.mjs';

test('the pill reads sent today out of the daily limit, never the batch share', () => {
  assert.equal(acctPillCount({ dailyCount: 12, dailyLimit: 50 }, { sent: 12, total: 13 }), '12/50');
  assert.equal(acctPillCount({ dailyCount: 0, dailyLimit: 50 }, null), '0/50');
});

test('a capped account reads as capped', () => {
  assert.equal(acctPillCount({ dailyCount: 50, dailyLimit: 50 }), '50/50');
});

test('no daily limit known says what was sent rather than invent a denominator', () => {
  // "12/0" is worse than no denominator at all.
  assert.equal(acctPillCount({ dailyLimit: 0 }, { sent: 12, total: 13 }), '12 sent');
  assert.equal(acctPillCount({}), '0 sent');
});

test('a campaign that never started offers one safe restart, worded for that', () => {
  const r = failedStartRetry({ bad: true, badLabel: 'Error', id: 'c1', totalTargets: 123, totalProcessed: 0 });
  assert.equal(r.headline, 'This campaign never started');
  assert.equal(r.label, 'Try again');
  assert.match(r.detail, /all 123 leads are still queued/);
});

test('a campaign that sent before failing never offers to start over', () => {
  // From-the-beginning would re-invite the 31 people it already reached.
  const r = failedStartRetry({ bad: true, badLabel: 'Error', id: 'c1', totalTargets: 123, totalProcessed: 31 });
  assert.equal(r.headline, 'Stopped after 31 of 123');
  assert.equal(r.label, 'Carry on from lead 32');
  assert.match(r.detail, /92 leads are still queued/);
  assert.match(r.onclick, /false\)$/);
});

test('the engine reason leads the sentence when there is one', () => {
  const r = failedStartRetry({ bad: true, badLabel: 'Error', endNotice: 'GoLogin refused the browser.', totalTargets: 4 });
  assert.match(r.detail, /^GoLogin refused the browser\./);
});

test('a campaign the operator stopped still gets a way back in when work is left', () => {
  // The block is about unfinished work, not about blame: 4 leads were never
  // touched, so there is something to offer whoever pressed Stop.
  const r = failedStartRetry({ bad: true, badLabel: 'Stopped', totalTargets: 4 });
  assert.equal(r.label, 'Start from the first lead');
  // Nothing left to do, and nothing wrong: no block.
  assert.equal(failedStartRetry({ bad: true, badLabel: 'Stopped', totalTargets: 4, totalProcessed: 4 }), null);
  assert.equal(failedStartRetry({ state: 'done', totalTargets: 4 }), null);
  assert.equal(failedStartRetry({}), null);
});

test('the errored card does not also keep the two restart glyphs', () => {
  // Same action offered twice, one of them the unsafe one.
  const c = vjCardControlsFor({ state: 'done', bad: true, badLabel: 'Error', id: 'c1', totalTargets: 9, totalProcessed: 3 });
  assert.equal(c.extra.filter((e) => e.kind === 'play' || e.kind === 'restart').length, 0);
  assert.ok(c.extra.some((e) => e.kind === 'dup'));
});

test('an operator-stopped campaign offers it once, not twice', () => {
  // The big block now covers this case too, so the small glyphs must stand down
  // — otherwise the same action is on the card twice, one of them unlabelled.
  const c = vjCardControlsFor({ state: 'done', bad: true, badLabel: 'Stopped', id: 'c1', totalTargets: 9, totalProcessed: 3 });
  assert.equal(c.extra.filter((e) => e.kind === 'play' || e.kind === 'restart').length, 0);
  assert.ok(c.extra.some((e) => e.kind === 'dup'));
});

test('failedStartRetry: a refused launch offers the settings, not a restart', () => {
  const r = failedStartRetry({
    bad: true, badLabel: 'Error', launchFailed: true, id: '__launching__',
    endNotice: 'No actionable leads were found. Try: Review sheet and filters.',
  });
  assert.equal(r.headline, 'The campaign was not started');
  assert.equal(r.onclick, 'dismissCloudLaunch()');
  assert.match(r.detail, /Review sheet and filters/);
  assert.match(r.detail, /no lead was used/);
});

test('failedStartRetry: a stopped campaign with leads left gets the big way back in', () => {
  const r = failedStartRetry({
    bad: true, badLabel: 'Stopped early', _cloud: true, id: 'c1',
    totalProcessed: 0, totalTargets: 4, stopReason: 'operator_stopped',
  });
  assert.equal(r.headline, 'Stopped before anything was sent');
  assert.equal(r.label, 'Start from the first lead');
  assert.match(r.detail, /all 4 leads are still queued/);
});

test('failedStartRetry: a stopped campaign part-way through carries on', () => {
  const r = failedStartRetry({
    bad: true, badLabel: 'Stopped early', _cloud: true, id: 'c1',
    totalProcessed: 7, totalTargets: 20, stopReason: 'operator_stopped',
  });
  assert.equal(r.headline, 'Stopped after 7 of 20');
  assert.equal(r.label, 'Carry on from lead 8');
});

test('failedStartRetry: a finished campaign is offered nothing', () => {
  assert.equal(failedStartRetry({ bad: true, badLabel: 'Stopped', totalProcessed: 20, totalTargets: 20 }), null);
  assert.equal(failedStartRetry({ bad: false, totalProcessed: 0, totalTargets: 4 }), null);
});

// Same operator, 2026-09-02: "why is it sometimes out of 4 and sometimes out of
// 8?" — because the row was printing the account's share of the campaign's
// leads. The denominator he wanted is the turn.
test('the batch tooltip counts the turn, and says which turn it is', () => {
  assert.equal(acctBatchTip({ done: 4, planned: 8 }, null), '4 of 8 in its last batch');
  assert.equal(acctBatchTip({ done: 4, planned: 8 }, { done: 3, total: 8 }), '3 of 8 in this batch');
});

test('an account with no turn to report gets no tooltip rather than an empty one', () => {
  assert.equal(acctBatchTip(null, null), '');
  assert.equal(acctBatchTip({ done: 0, planned: 0 }, null), '');
  // A live account between leads has a phase but no counted turn yet.
  assert.equal(acctBatchTip(null, { done: 0, total: 0 }), '');
});

// The row redesign, 2026-09-02. The panel used to hang six badges of equal
// weight on every account, including green ones announcing that nothing was
// wrong ("this is very very very ugly"). Now: a dot, a pill only when there IS
// something to say, and the count. These tests pin what earns a pill and what
// colour the dot goes, because that is the whole readability of the panel.
const CCIC = { isCCIC: true, nextMonday: 'Monday 7 Sept' };

test('an account that is sending and connected says nothing at all', () => {
  const st = acctRowState({ dailyCount: 20, dailyLimit: 50, primaryConnected: true }, CCIC);
  assert.equal(st.dot, 'ok');
  assert.deepEqual(st.pills, []);
});

test('sending, but unable to introduce, is amber and says which of the two it is', () => {
  // Never checked and checked-and-not-connected are different facts. Collapsing
  // them is what made six unchecked accounts read as six failures.
  const never = acctRowState({ dailyCount: 20, dailyLimit: 50, primaryConnected: null }, CCIC);
  assert.equal(never.dot, 'warn');
  assert.deepEqual(never.pills, [['warn', 'Primary not checked']]);
  const no = acctRowState({ dailyCount: 20, dailyLimit: 50, primaryConnected: false }, CCIC);
  assert.equal(no.dot, 'warn');
  assert.deepEqual(no.pills, [['warn', 'Primary not connected']]);
});

test('a campaign with no primary person is never asked about one', () => {
  const st = acctRowState({ dailyCount: 20, dailyLimit: 50, primaryConnected: null }, { isCCIC: false });
  assert.equal(st.dot, 'ok');
  assert.deepEqual(st.pills, []);
});

test('an account that is not sending is red, and the pill says why', () => {
  assert.deepEqual(acctRowState({ needsLogin: true }, CCIC).pills[0], ['bad', 'Logged out']);
  assert.deepEqual(acctRowState({ parked: true, parkReason: 'proxy' }, CCIC).pills[0], ['bad', 'Proxy refused']);
  assert.deepEqual(acctRowState({ weeklyCap: true }, CCIC).pills[0], ['bad', 'Stopped until Monday 7 Sept']);
  assert.deepEqual(acctRowState({ parked: true, parkReason: 'throttle' }, CCIC).pills[0], ['bad', 'Throttled']);
  assert.deepEqual(acctRowState({ dailyCount: 50, dailyLimit: 50 }, CCIC).pills[0], ['bad', 'Daily limit reached']);
  for (const a of [{ needsLogin: true }, { weeklyCap: true }, { dailyCount: 50, dailyLimit: 50 }]) {
    assert.equal(acctRowState(a, CCIC).dot, 'bad');
  }
});

test('blocked AND unable to introduce shows both, with the worse dot', () => {
  // Hiding the primary problem behind a temporary one is how it stays hidden.
  const st = acctRowState({ parked: true, parkReason: 'throttle', primaryConnected: null }, CCIC);
  assert.equal(st.dot, 'bad');
  assert.deepEqual(st.pills, [['bad', 'Throttled'], ['warn', 'Primary not checked']]);
});

test('a weekly cap offers no way to try again — it is a window, not a cooldown', () => {
  assert.equal(acctRowState({ weeklyCap: true }, CCIC).weekly, true);
  assert.equal(acctRowState({ parked: true, parkReason: 'throttle' }, CCIC).weekly, false);
});

test('spent invitation notes are worth a word but never turn the dot red', () => {
  const st = acctRowState({ dailyCount: 3, dailyLimit: 50, primaryConnected: true, noteExhausted: true }, CCIC);
  assert.equal(st.dot, 'ok');
  assert.deepEqual(st.pills, [['warn', 'No note left']]);
});

test('an SoO restriction is a block wherever it appears', () => {
  const st = acctRowState({ dailyCount: 3, dailyLimit: 50, primaryConnected: true, identityRestricted: true, restrictionLabel: 'Identity Restricted' }, CCIC);
  assert.equal(st.dot, 'bad');
  assert.deepEqual(st.pills, [['bad', 'Identity Restricted']]);
});

test('the bench pill carries the date, the drawer carries the countdown', () => {
  const st = acctRowState({ weeklyCap: true }, { isCCIC: true, nextMonday: 'Monday 7 Sept (in 5 days)' });
  assert.deepEqual(st.pills[0], ['bad', 'Stopped until Monday 7 Sept']);
  assert.match(st.status, /resets Monday 7 Sept \(in 5 days\)/);
});
