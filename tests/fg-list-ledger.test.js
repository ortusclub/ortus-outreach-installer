import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerUpdatesFromLeads, extractMemberIdFromUrl, fmtInvitedAt } from '../src/connections/fg-list.js';

test('extractMemberIdFromUrl pulls the encoded member URN, ignores vanity slugs', () => {
  assert.equal(extractMemberIdFromUrl('https://www.linkedin.com/in/ACwAABOG8QAB3TR2cvgO0PmNaXWYmQJA8'), 'ACwAABOG8QAB3TR2cvgO0PmNaXWYmQJA8');
  assert.equal(extractMemberIdFromUrl('https://www.linkedin.com/in/chathura'), '');
  assert.equal(extractMemberIdFromUrl(''), '');
});

test('fmtInvitedAt renders a stable UTC stamp, blank on bad input', () => {
  assert.equal(fmtInvitedAt('2026-07-24T09:20:51.713Z'), '2026-07-24 09:20 UTC');
  assert.equal(fmtInvitedAt(''), '');
  assert.equal(fmtInvitedAt('not-a-date'), '');
});

test('ledgerUpdatesFromLeads: only actioned leads produce updates', () => {
  const out = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/haque16', status: 'sent', stage: 'Invited', sentAt: '2026-07-24T09:20:51.713Z' },
    { leadUrl: 'https://www.linkedin.com/in/x', status: 'skipped', error: 'already connected' },
    { leadUrl: 'https://www.linkedin.com/in/z', status: 'error', error: 'invite failed' },
    { leadUrl: 'https://www.linkedin.com/in/y', status: 'pending' },      // no update
    { leadUrl: '', status: 'sent' },                                       // no url → dropped
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { url: 'https://www.linkedin.com/in/haque16', status: 'Invited', invitedAt: '2026-07-24 09:20 UTC', note: '', memberId: '' });
  assert.deepEqual(out[1], { url: 'https://www.linkedin.com/in/x', status: 'Skipped', note: 'already connected' });
  assert.deepEqual(out[2], { url: 'https://www.linkedin.com/in/z', status: 'Failed', note: 'invite failed' });
});
