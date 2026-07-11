import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsHandshakeFromBody, handshakeRowView } from '../public/js/handshake-gate.mjs';

const ccic = (over = {}) => ({
  mode: 'connect_and_introduce',
  templates: { autoAcceptPrimary: true, primarySource: 'local-browser', ...over },
});

test('needsHandshakeFromBody: CC+IC + auto-accept + local-browser → true', () => {
  assert.equal(needsHandshakeFromBody(ccic()), true);
});
test('needsHandshakeFromBody: primarySource omitted defaults to local-browser', () => {
  const b = { mode: 'connect_and_introduce', templates: { autoAcceptPrimary: true } };
  assert.equal(needsHandshakeFromBody(b), true);
});
test('needsHandshakeFromBody: GoLogin primary → false', () => {
  assert.equal(needsHandshakeFromBody(ccic({ primarySource: 'gl-abc' })), false);
});
test('needsHandshakeFromBody: auto-accept off → false', () => {
  assert.equal(needsHandshakeFromBody(ccic({ autoAcceptPrimary: false })), false);
});
test('needsHandshakeFromBody: non-CC+IC → false', () => {
  assert.equal(needsHandshakeFromBody({ mode: 'connect_only', templates: { autoAcceptPrimary: true } }), false);
});
test('needsHandshakeFromBody: missing templates / empty body → false, no throw', () => {
  assert.equal(needsHandshakeFromBody({}), false);
  assert.equal(needsHandshakeFromBody(), false);
});

test('handshakeRowView: connected is the only done state', () => {
  assert.equal(handshakeRowView('connected').done, true);
  for (const s of ['pending', 'connecting', 'sent', 'accepting', 'error', 'sent-no-identity']) {
    assert.equal(handshakeRowView(s).done, false, s);
  }
});
test('handshakeRowView: unknown state falls back to pending', () => {
  assert.deepEqual(handshakeRowView('nonsense'), handshakeRowView('pending'));
});
