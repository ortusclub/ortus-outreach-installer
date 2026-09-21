import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPastedAccounts } from '../public/js/account-paste.mjs';
import { CREDIT_RETRY_STAGE, creditChannelForMode, isPreSendCreditRetryable } from '../src/credit-recovery.js';

test('pasted sheet column selects exact available accounts in input order', () => {
  const profiles = [
    { id: 'a', name: 'camille@example.com' },
    { id: 'b', name: 'ritika@example.com' },
    { id: 'c', name: 'locked@example.com' },
  ];
  const rows = previewPastedAccounts('ritika@example.com\ncamille@example.com\ncamille@example.com\nlocked@example.com\nunknown@example.com', profiles, p => p.id !== 'c');
  assert.deepEqual(rows.map(r => r.status), ['ready', 'ready', 'duplicate', 'unavailable', 'unmatched']);
  assert.deepEqual(rows.filter(r => r.status === 'ready').map(r => r.profile.id), ['b', 'a']);
});

test('credit recovery only permits proven pre-send failures in the right channel', () => {
  assert.equal(CREDIT_RETRY_STAGE, 'Retry queued');
  assert.equal(creditChannelForMode('connect_and_introduce'), 'cc');
  assert.equal(creditChannelForMode('connect_and_message'), 'cc');
  assert.equal(creditChannelForMode('open_profile_only'), 'inmail');
  assert.equal(isPreSendCreditRetryable('connect_and_introduce', 'Connect failed: Connect button not found after 60s'), true);
  assert.equal(isPreSendCreditRetryable('open_profile_only', 'Sales Nav compose textbox did not appear'), true);
  for (const reason of ['SEND_NOT_CONFIRMED', 'VOYAGER_REJECTED HTTP 429', 'LinkedIn error toast', 'Profile not found (404)', 'Not Open Profile', 'CONNECT_MODAL_WRONG_PERSON', 'identity_unverified']) {
    assert.equal(isPreSendCreditRetryable('connect_and_message', reason), false, reason);
    assert.equal(isPreSendCreditRetryable('open_profile_only', reason), false, reason);
  }
});
