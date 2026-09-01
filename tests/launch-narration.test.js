// The 11:59 launch recording, turned into tests.
//
// For 75 seconds the card showed: a log header counting six events above six
// blank rows, a step strip frozen on "reading your leads" while the headline
// said the VM had already accepted the campaign, and then two minutes of
// silence while a worker woke. An operator watching that reads a stalled
// campaign, and said so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchMilestones, queueWaitLine } from '../public/js/live-activity.mjs';
import { nextCheckLabel } from '../public/js/campaign-status-contract.mjs';

test('the strip moves off the sheet once the engine has the campaign', () => {
  const reading = launchMilestones({ phase: 'dispatching', hasHandshake: false });
  assert.deepEqual(reading[1], ['Sheet', 'reading your leads', 'active']);
  assert.equal(reading[2][2], 'future');

  const accepted = launchMilestones({ phase: 'accepted', hasHandshake: false, leadsRead: 4 });
  assert.deepEqual(accepted[1], ['Sheet', '4 leads read', 'done']);
  assert.deepEqual(accepted[2], ['VM', 'waiting for a worker', 'active']);
});

test('one lead is not "1 leads read"', () => {
  assert.equal(launchMilestones({ phase: 'accepted', leadsRead: 1, hasHandshake: false })[1][1], '1 lead read');
});

test('the handshake journey shows its senders, then advances past them', () => {
  const shaking = launchMilestones({ phase: 'handshake', hasHandshake: true, sendersDone: 1, sendersTotal: 3 });
  assert.deepEqual(shaking[1], ['Accounts', '1 of 3 connected', 'active']);
  assert.equal(shaking[2][2], 'future', 'the sheet is not being read during the handshake');

  const later = launchMilestones({ phase: 'dispatching', hasHandshake: true, sendersTotal: 3 });
  assert.deepEqual(later[1], ['Accounts', '3 connected', 'done']);
  assert.equal(later[2][2], 'active');
});

test('no step is ever both done and still in progress', () => {
  for (const phase of ['handshake', 'preflight', 'dispatching', 'accepted', '']) {
    for (const hasHandshake of [true, false]) {
      const miles = launchMilestones({ phase, hasHandshake, leadsRead: 4, sendersTotal: 2 });
      assert.equal(miles.length, 4, `${phase}/${hasHandshake} always has four steps`);
      assert.ok(miles.filter((m) => m[2] === 'active').length <= 1, `${phase}/${hasHandshake} has at most one active step`);
      miles.forEach(([label, value]) => {
        assert.ok(label && value, 'every step says something');
      });
    }
  }
});

test('the wait says how long it has been, and what is normal', () => {
  assert.match(queueWaitLine(30), /^⏳ Still waiting for a VM worker · 30s/);
  assert.match(queueWaitLine(90), /1m 30s/);
  assert.match(queueWaitLine(90), /about 2 minutes to wake/);
});

test('past three minutes it stops calling the wait normal', () => {
  const late = queueWaitLine(210);
  assert.match(late, /3m 30s/);
  assert.match(late, /longer than the usual 2 minutes/);
  assert.match(late, /Nothing is lost/);
});

test('a check time is never printed as a raw timestamp', () => {
  // The exact value from the operator's screenshot.
  const now = new Date('2026-08-28T09:00:00').getTime();
  const label = nextCheckLabel('2026-08-28T10:28:49.180Z', now);
  assert.doesNotMatch(label, /\d{4}-\d{2}-\d{2}T/, 'no ISO string reaches the card');
  assert.match(label, /^today at \d{1,2}:\d{2}/);
});

test('a check scheduled for tomorrow is not announced as today', () => {
  const now = new Date('2026-08-28T09:00:00').getTime();
  assert.match(nextCheckLabel(new Date('2026-08-29T09:30:00').getTime(), now), /^tomorrow at /);
  assert.equal(nextCheckLabel(null, now), 'being scheduled');
  assert.equal(nextCheckLabel('not a date', now), 'being scheduled');
});

// The operator action beside a healthy monitoring card, and the wording beside
// a failed one. The canonical path owns the STATE; the recovery copy this app
// has always had owns the WORDS.
test('a monitoring card only asks for an operator action when a sweep left an account unchecked', async () => {
  const { overlayCampaignStatus } = await import('../public/js/campaign-status-contract.mjs');
  const snap = (progress, checkError = '') => ({
    contractVersion: 1, campaignId: 'c1', sequence: 1, observedAt: Date.now(),
    lifecycle: 'monitoring', activity: 'waiting', progress,
    headline: 'Waiting for the next acceptance check',
    detail: 'Monitoring is active. No browser remains open between checks.',
    safety: '177 pending leads remain safe',
    next: { checkAt: '2026-08-28T10:28:49.180Z', checkError },
  });
  const actionOf = (s) => overlayCampaignStatus({}, s).currentAction;
  const factsOf = (s) => Object.fromEntries(actionOf(s).facts);

  const whole = factsOf(snap({ accountsChecked: 3, accountsExpected: 3, pending: 177 }));
  assert.equal(whole['Operator action'], 'none required', 'every account was checked — nothing to do');
  assert.doesNotMatch(whole['Next check'], /T\d{2}:/, 'and never a raw timestamp');
});

test('the merged monitoring card carries the recovery copy, not a bare instruction', async () => {
  const { overlayCampaignStatus } = await import('../public/js/campaign-status-contract.mjs');
  const ca = overlayCampaignStatus({}, {
    contractVersion: 1, campaignId: 'c1', sequence: 1, observedAt: Date.now(),
    lifecycle: 'monitoring', activity: 'waiting',
    headline: 'Waiting for the next acceptance check',
    detail: 'Monitoring is active. No browser remains open between checks.',
    safety: '177 pending leads remain safe',
    progress: { accountsChecked: 2, accountsExpected: 3, pending: 177 },
    next: { checkAt: '2026-08-28T10:28:49.180Z', checkError: 'damiano@ortus.solutions — needs re-login' },
  }).currentAction;

  // The headline must stop claiming everything is fine while an account is locked out.
  assert.match(ca.label, /session expired/i);
  assert.doesNotMatch(ca.label, /Waiting for the next acceptance check/);
  assert.match(ca.sub, /^2 of 3 accounts were checked/);
  assert.match(ca.sub, /GoLogin/, 'it says where to go, not just that something is wrong');

  const facts = Object.fromEntries(ca.facts);
  assert.equal(facts['Last check'], '2 of 3 accounts');
  assert.match(facts['Result'], /needs login/i);
  assert.doesNotMatch(facts['Operator action'], /the named account/, 'never the anonymous instruction');
});

test('the safety line says the leads are not moving, not just that they are safe', async () => {
  const { overlayCampaignStatus } = await import('../public/js/campaign-status-contract.mjs');
  const ca = overlayCampaignStatus({}, {
    contractVersion: 1, campaignId: 'c1', sequence: 1, observedAt: Date.now(),
    lifecycle: 'monitoring', activity: 'waiting', safety: '177 pending leads remain safe',
    progress: { accountsChecked: 3, accountsExpected: 3, pending: 177 }, next: {},
  }).currentAction;
  assert.match(ca.safety, /^177 pending leads remain safely queued/);
  assert.match(ca.safety, /sending is stopped/);
});

test('a monitoring card with nothing left to send does not claim leads are queued', async () => {
  const { overlayCampaignStatus } = await import('../public/js/campaign-status-contract.mjs');
  const ca = overlayCampaignStatus({}, {
    contractVersion: 1, campaignId: 'c1', sequence: 1, observedAt: Date.now(),
    lifecycle: 'monitoring', activity: 'waiting', safety: '0 pending leads remain safe',
    progress: { accountsChecked: 3, accountsExpected: 3, pending: 0 }, next: {},
  }).currentAction;
  assert.doesNotMatch(ca.safety, /sending is stopped/);
});
