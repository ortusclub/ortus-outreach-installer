import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseCampaign } from '../src/campaign-summary.js';
import { emptyTally, applyOutcome } from '../src/campaign-tally.js';

function tallyOf(...outcomes) {
  return outcomes.reduce((t, o) => applyOutcome(t, o), emptyTally());
}

test('healthy connect run → 🟢, no issue', () => {
  const t = tallyOf({ phase: 'Request', outcome: 'sent' }, { phase: 'Accept', outcome: 'accepted' });
  const r = summariseCampaign({ name: 'JFROG', operator: 'jeremiah', mode: 'connect_and_introduce', totalTargets: 14, processed: 13, tally: t });
  assert.equal(r.status, 'ok');
  assert.equal(r.statusLabel, '🟢 Healthy');
  assert.equal(r.topIssue, '');
  assert.equal(r.progress, 93);
});

test('session expired → 🔴 Needs you + plain-English why', () => {
  const t = tallyOf({ phase: 'Account', outcome: 'skipped', reason: 'Session expired' });
  const r = summariseCampaign({ name: 'AUD', operator: 'jhan', mode: 'connect_and_introduce', totalTargets: 9, processed: 7, tally: t });
  assert.equal(r.status, 'need');
  assert.match(r.why, /logged out/i);
});

test('rate-limited → 🟡 Slowed', () => {
  const t = tallyOf({ phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
  const r = summariseCampaign({ name: 'NICE', mode: 'connect_only', totalTargets: 871, processed: 212, tally: t });
  assert.equal(r.status, 'slow');
  assert.match(r.why, /throttling|safe/i);
  assert.equal(r.progress, 24);
});

test('need outranks slow when both present', () => {
  const t = tallyOf(
    { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' },
    { phase: 'Intro', outcome: 'error', reason: 'Failed — Primary not in your connections' },
  );
  const r = summariseCampaign({ name: 'X', mode: 'connect_and_introduce', totalTargets: 10, processed: 5, tally: t });
  assert.equal(r.status, 'need');
  assert.match(r.topIssue, /Primary not in your connections/);
});

test('ended → ⚪ Done regardless of issues', () => {
  const t = tallyOf({ phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
  const r = summariseCampaign({ name: 'SFLK', mode: 'introduce_back', ended: true, endReason: 'completed', totalTargets: 13, processed: 13, tally: t });
  assert.equal(r.status, 'done');
  assert.equal(r.statusLabel, '⚪ Done');
  assert.match(r.doingNow, /Finished/);
});

test('doingNow reflects intro phase for CC+IC', () => {
  const t = tallyOf({ phase: 'Intro', outcome: 'sent' });
  const r = summariseCampaign({ name: 'X', mode: 'connect_and_introduce', totalTargets: 10, processed: 4, tally: t });
  assert.match(r.doingNow, /Introducing/);
  assert.match(r.doingNow, /4 of 10/);
});

test('issues counts distinct reason buckets', () => {
  const t = tallyOf(
    { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' },
    { phase: 'Account', outcome: 'parked', reason: 'Weekly limit reached' },
    { phase: 'Request', outcome: 'skipped', reason: 'Legacy Sales Nav URL' },
  );
  const r = summariseCampaign({ name: 'X', mode: 'connect_only', totalTargets: 100, processed: 50, tally: t });
  assert.equal(r.issues, 3);
});

test('no args → never throws, safe defaults', () => {
  assert.doesNotThrow(() => summariseCampaign());
  const r = summariseCampaign();
  assert.equal(r.status, 'ok');
  assert.equal(r.progress, 0);
});
