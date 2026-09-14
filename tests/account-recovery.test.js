import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryAction, historyRecoveryAccounts, safeProfileUrl } from '../public/js/account-recovery.mjs';
import { observeOpenInvitation } from '../src/invitation-observation.js';
import { statusFromItem } from '../public/js/vjcard.mjs';

test('login, uncertainty and limits do not become Retry actions', () => {
  assert.equal(recoveryAction({ needsLogin: true }).kind, 'login');
  assert.equal(recoveryAction({ parkReason: 'session_expired' }).kind, 'login');
  assert.equal(recoveryAction({ parkReason: 'unconfirmed_streak' }).kind, 'verify');
  assert.equal(recoveryAction({ weeklyCap: true }).kind, 'cooldown');
  assert.equal(recoveryAction({}), null);
});
test('history restores exact account and affected lead; ambiguous names are not guessed', () => {
  const h = { settings: { profileIds: ['idA'] }, profiles: ['sender'], debrief: {
    skips: [{ profileName: 'sender', url: 'https://www.linkedin.com/in/lead/', detail: 'HTTP 429 — confirming…' }],
    perAccount: [{ profileId: 'idA', name: 'sender' }], endNotice: { reason: 'all_parked' },
  } };
  const a = historyRecoveryAccounts(h);
  assert.equal(a[0].profileId, 'idA'); assert.equal(a[0].verificationLeads.length, 1);
  const s = statusFromItem({ hist: h, bucket: 'done' });
  assert.deepEqual(s.recoveryAccounts, a); assert.equal(s.endNotice.reason, 'all_parked');
  h.debrief.perAccount.push({ profileId: 'idB', name: 'sender' });
  assert.deepEqual(historyRecoveryAccounts(h), []);
});
test('only safe LinkedIn profile URLs accepted', () => {
  for (const url of ['https://evil.test/in/a', 'javascript:alert(1)', 'https://linkedin.com@evil.test/in/a', 'https://www.linkedin.com/feed/']) assert.equal(safeProfileUrl(url), null);
});
test('verification never launches a missing browser', async () => {
  const r = await observeOpenInvitation({ browser: null, url: 'https://www.linkedin.com/in/a' });
  assert.equal(r.state, 'unavailable');
});
test('verification reads only the exact single open recipient tab', async () => {
  let evaluated = 0;
  const page = { url: () => 'https://www.linkedin.com/in/a/', isClosed: () => false, evaluate: async () => { evaluated++; return 'pending_observed'; } };
  assert.equal((await observeOpenInvitation({ browser: { pages: async () => [page] }, url: 'https://www.linkedin.com/in/b' })).state, 'unavailable');
  assert.equal(evaluated, 0);
  assert.equal((await observeOpenInvitation({ browser: { pages: async () => [page, page] }, url: 'https://www.linkedin.com/in/a' })).state, 'unavailable');
  assert.equal(evaluated, 0);
  assert.equal((await observeOpenInvitation({ browser: { pages: async () => [page] }, url: 'https://www.linkedin.com/in/a' })).state, 'pending_observed');
  assert.equal(evaluated, 1);
});
test('missing Pending and navigation races stay unresolved, never retryable', async () => {
  let url = 'https://www.linkedin.com/in/a';
  const page = { url: () => url, isClosed: () => false, evaluate: async () => 'unknown' };
  const args = { browser: { pages: async () => [page] }, url };
  assert.equal((await observeOpenInvitation(args)).state, 'unknown');
  page.evaluate = async () => { url = 'https://www.linkedin.com/in/b'; return 'pending_observed'; };
  assert.equal((await observeOpenInvitation(args)).state, 'unknown');
});
