import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSoOTarget } from '../src/soo-writer.js';

test('connection_sent in any connect mode → CC column + CC App User (column AJ)', () => {
  for (const mode of ['connect_only', 'connect_and_introduce', 'connect_and_message']) {
    assert.deepEqual(
      resolveSoOTarget(mode, 'connection_sent'),
      { creditHeader: 'CC (Credits)', userHeader: 'CC App User' },
      mode,
    );
  }
});

test('inmail_sent in inmail_only → Inmail column + Inmail User', () => {
  assert.deepEqual(
    resolveSoOTarget('inmail_only', 'inmail_sent'),
    { creditHeader: 'Inmail Credits', userHeader: 'Inmail User' },
  );
});

test('open_profile_only writes nothing — even on its InMail fallback', () => {
  assert.equal(resolveSoOTarget('open_profile_only', 'op_message_sent'), null);
  assert.equal(resolveSoOTarget('open_profile_only', 'inmail_sent'), null);
});

test('inmail_sent only counts in inmail_only mode', () => {
  assert.equal(resolveSoOTarget('connect_only', 'inmail_sent'), null);
});

test('non-send / check / dm-to-connection actions → null', () => {
  assert.equal(resolveSoOTarget('connect_only', 'already_connected'), null);
  assert.equal(resolveSoOTarget('connect_only', 'already_processed'), null);
  assert.equal(resolveSoOTarget('connect_only', 'status_pending'), null);
  assert.equal(resolveSoOTarget('introduce_back', 'message_sent'), null);
  assert.equal(resolveSoOTarget('message_only', 'message_sent'), null);
  assert.equal(resolveSoOTarget('check_status', 'status_accepted'), null);
});
