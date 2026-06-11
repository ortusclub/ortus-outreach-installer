import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTally, applyOutcome } from '../src/campaign-tally.js';

test('emptyTally starts at zero', () => {
  assert.deepEqual(emptyTally(), {
    sent: 0, accepted: 0, intro: 0, dm: 0, replied: 0,
    rateLimited: 0, parked: 0, skipped: 0, errors: 0, byReason: {},
  });
});

test('applyOutcome counts sent + phase split (intro / dm)', () => {
  let t = emptyTally();
  t = applyOutcome(t, { phase: 'Request', outcome: 'sent', reason: '' });
  t = applyOutcome(t, { phase: 'Intro', outcome: 'sent', reason: '' });
  t = applyOutcome(t, { phase: 'DM', outcome: 'sent', reason: '' });
  assert.equal(t.sent, 3);
  assert.equal(t.intro, 1);
  assert.equal(t.dm, 1);
});

test('applyOutcome tracks accepted', () => {
  let t = emptyTally();
  t = applyOutcome(t, { phase: 'Accept', outcome: 'accepted', reason: '' });
  assert.equal(t.accepted, 1);
});

test('applyOutcome tracks leaks + byReason buckets', () => {
  let t = emptyTally();
  t = applyOutcome(t, { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
  t = applyOutcome(t, { phase: 'Account', outcome: 'parked', reason: 'Weekly limit reached' });
  t = applyOutcome(t, { phase: 'Request', outcome: 'skipped', reason: 'Session expired' });
  t = applyOutcome(t, { phase: 'Request', outcome: 'skipped', reason: 'Session expired' });
  assert.equal(t.rateLimited, 1);
  assert.equal(t.parked, 1);
  assert.equal(t.skipped, 2);
  assert.equal(t.byReason['Session expired'], 2);
  assert.equal(t.byReason['Rate-limited (HTTP 429)'], 1);
});

test('applyOutcome is immutable (does not mutate input)', () => {
  const t0 = emptyTally();
  const t1 = applyOutcome(t0, { phase: 'Request', outcome: 'sent' });
  assert.equal(t0.sent, 0);
  assert.equal(t1.sent, 1);
});

test('applyOutcome tolerates null tally / null cls', () => {
  assert.doesNotThrow(() => applyOutcome(null, null));
  const t = applyOutcome(null, { outcome: 'sent', phase: 'Request' });
  assert.equal(t.sent, 1);
});
