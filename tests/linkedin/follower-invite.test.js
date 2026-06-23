import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditsAvailable, headlineMatches, pickInviteResult } from '../../src/linkedin/follower-invite.js';

test('parseCreditsAvailable reads the leading number', () => {
  assert.equal(parseCreditsAvailable('30/30 credits available · Credit refill: June 30, 2026'), 30);
  assert.equal(parseCreditsAvailable('7 / 30 credits available'), 7);
  assert.equal(parseCreditsAvailable('no credits text'), 0);
  assert.equal(parseCreditsAvailable(''), 0);
});

test('headlineMatches: company token or significant title word', () => {
  assert.equal(headlineMatches('Head of Marketing at ADAC', { jobTitle: 'Head of Marketing', company: 'ADAC' }), true);
  assert.equal(headlineMatches('Strategy Manager @ Sector Alarm', { jobTitle: 'VP Growth', company: 'Globex' }), false);
  assert.equal(headlineMatches('Chief Growth Officer', { jobTitle: 'VP Growth', company: '' }), true);
  assert.equal(headlineMatches('', { jobTitle: 'Marketing', company: 'X' }), false);
});

test('pickInviteResult: single name match selected without headline', () => {
  const results = [{ name: 'Mara Lee', headline: 'Barista', canInvite: true }];
  const r = pickInviteResult(results, { name: 'Mara Lee', jobTitle: 'Head of Marketing', company: 'Acme' });
  assert.equal(r, results[0]);
});

test('pickInviteResult: duplicate names disambiguated by headline', () => {
  const results = [
    { name: 'John Smith', headline: 'Chef at Bistro', canInvite: true },
    { name: 'John Smith', headline: 'Head of Marketing at Acme', canInvite: true },
  ];
  const r = pickInviteResult(results, { name: 'John Smith', jobTitle: 'Head of Marketing', company: 'Acme' });
  assert.equal(r, results[1]);
});

test('pickInviteResult: ambiguous duplicates → null (skip)', () => {
  const results = [
    { name: 'John Smith', headline: 'Marketing Lead at Acme', canInvite: true },
    { name: 'John Smith', headline: 'Marketing Director at Acme', canInvite: true },
  ];
  assert.equal(pickInviteResult(results, { name: 'John Smith', jobTitle: 'Marketing', company: 'Acme' }), null);
});

test('pickInviteResult: non-invitable + zero matches → null', () => {
  assert.equal(pickInviteResult([{ name: 'Mara Lee', headline: 'x', canInvite: false }], { name: 'Mara Lee' }), null);
  assert.equal(pickInviteResult([], { name: 'Nobody' }), null);
});
