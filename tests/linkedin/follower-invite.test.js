import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditsAvailable, parseCreditsMeta, headlineMatches, pickInviteResult, waitForModalContent } from '../../src/linkedin/follower-invite.js';

test('parseCreditsMeta extracts available, allowance, and refill date', () => {
  const t = 'Send your connections an invitation... 5/30 credits available · Credit refill: June 30, 2026 Locations';
  assert.deepEqual(parseCreditsMeta(t), { available: 5, allowance: 30, refill: 'June 30, 2026' });
});

test('parseCreditsMeta returns nulls when the credits line is absent', () => {
  assert.deepEqual(parseCreditsMeta('Invite to follow Dialog content end.'), { available: null, allowance: null, refill: '' });
});

// A fake puppeteer page that returns scripted search-box / result-row presence on
// successive poll rounds. One round advances per page.$ call (the search probe,
// fired first each loop iteration). The selector string decides which signal the
// round reports: SEL.search starts with "input", SEL.result does not.
function fakePage(rounds) {
  let i = -1;
  const cur = () => rounds[Math.min(i, rounds.length - 1)] || {};
  return {
    polls: () => i + 1,
    $eval: async () => cur().text || '',
    $: async (sel) => {
      const wantSearch = String(sel).startsWith('input');
      // advance the round on the search probe (the first $ call per iteration)
      if (wantSearch) i++;
      return (wantSearch ? cur().hasSearch : cur().hasRow) ? {} : null;
    },
  };
}

test('waitForModalContent waits for the search box, not the credits text', async () => {
  // Credits render early (rounds 1-2) but the search box only mounts on round 3 —
  // readiness must hold off until the box exists, else selectPerson types too soon.
  const page = fakePage([{ text: '30/30 credits available' }, { text: '30/30 credits available' }, { hasSearch: true }]);
  const r = await waitForModalContent(page, { sleep: async () => {} });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'search');
  assert.equal(r.polls, 3);
});

test('waitForModalContent resolves "rows" when a result row appears (no search box)', async () => {
  const page = fakePage([{}, { hasRow: true }]);
  const r = await waitForModalContent(page, { sleep: async () => {} });
  assert.equal(r.ready, true);
  assert.equal(r.via, 'rows');
  assert.equal(r.polls, 2);
});

test('waitForModalContent times out when neither search box nor rows ever render', async () => {
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
