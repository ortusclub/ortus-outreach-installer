import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditsAvailable, headlineMatches, pickInviteResult, waitForModalContent } from '../../src/linkedin/follower-invite.js';

// A fake puppeteer page that returns scripted modal text / result-row presence
// on successive poll rounds. One round advances per $eval call (the first call
// each loop iteration); $ reflects the same round.
function fakePage(rounds) {
  let i = -1;
  const cur = () => rounds[Math.min(i, rounds.length - 1)] || {};
  return {
    polls: () => i + 1,
    $eval: async () => { i++; return cur().text || ''; },
    $: async () => (cur().hasRow ? {} : null),
  };
}

test('waitForModalContent resolves "credits" once the credits text renders late', async () => {
  const page = fakePage([{ text: '' }, { text: 'Dialog content start. Invite to follow' }, { text: '30/30 credits available' }]);
  const r = await waitForModalContent(page, { sleep: async () => {} });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'credits');
  assert.equal(r.polls, 3);
});

test('waitForModalContent resolves "rows" when a result row appears (no credits text)', async () => {
  const page = fakePage([{ text: '' }, { text: '', hasRow: true }]);
  const r = await waitForModalContent(page, { sleep: async () => {} });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'rows');
  assert.equal(r.polls, 2);
});

test('waitForModalContent times out when neither credits nor rows ever render', async () => {
  const page = fakePage([{ text: 'Dialog content start. Invite to follow Dialog content end.' }]);
  let clock = 0;
  const r = await waitForModalContent(page, { timeoutMs: 1000, pollMs: 250, sleep: async () => {}, now: () => { const v = clock; clock += 250; return v; } });
  assert.equal(r.ready, false);
  assert.equal(r.via, 'timeout');
});

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
