import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsHandshakeFromBody, handshakeRowView, handshakeStepView, handshakeOutcome } from '../public/js/handshake-gate.mjs';

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

// The launch used to offer "run the handshake on the VM instead", which set
// templates.primaryHandshakeOn='vm' and switched this gate off. Nothing in the
// engine ever read that key (grepped 2026-08-28, zero matches), so the senders
// were simply never connected to the primary — measured on the operator's
// 11:59 launch, where no account could show a Primary ✓ because nothing had
// connected. The option is gone (2026-08-28), and a leftover value on an old
// draft must not be able to skip the handshake silently.
test('no stored answer can switch the primary handshake off', () => {
  const body = {
    mode: 'connect_and_introduce',
    templates: { autoAcceptPrimary: true, primarySource: 'local-browser' },
  };
  assert.equal(needsHandshakeFromBody(body), true, 'a CC+IC cloud launch runs Path A');
  for (const answer of ['local', 'vm', '', null, undefined]) {
    assert.equal(
      needsHandshakeFromBody({ ...body, templates: { ...body.templates, primaryHandshakeOn: answer } }),
      true,
      `a stored answer of ${JSON.stringify(answer)} still runs Path A`,
    );
  }
});

test('answering the question cannot switch Path A ON for a campaign that never needed it', () => {
  // A message-only campaign has no primary handshake to place, whatever the
  // operator picked on a previous launch that left the field behind.
  assert.equal(needsHandshakeFromBody({
    mode: 'open_profile_only',
    templates: { autoAcceptPrimary: true, primaryHandshakeOn: 'local' },
  }), false);
});

test('handshakeStepView: step 2 starts only when every sender is past the invite', () => {
  const v1 = handshakeStepView([{ state: 'connected' }, { state: 'connecting' }]);
  assert.equal(v1.step, 1);
  assert.equal(v1.step1Done, false);
  const v2 = handshakeStepView([{ state: 'connected' }, { state: 'sent' }]);
  assert.equal(v2.step, 2);
  assert.equal(v2.step1Done, true);
  assert.equal(v2.step2Done, false);
  assert.equal(v2.connected, 1);
});

test('handshakeStepView: all connected finishes step 2', () => {
  const v = handshakeStepView([{ state: 'connected' }, { state: 'connected' }]);
  assert.equal(v.step2Done, true);
  assert.equal(v.connected, 2);
});

test('handshakeStepView: no senders is step 1, never a false "done"', () => {
  const v = handshakeStepView([]);
  assert.equal(v.step, 1);
  assert.equal(v.step2Done, false);
});

test('handshakeOutcome: the measured run (1 connected, 1 sent) is partial, not ok', () => {
  const o = handshakeOutcome({
    senders: [{ state: 'connected', name: 'Antonio' }, { state: 'sent', name: 'Rockey Sheikh' }],
    summary: { connected: 1, accepted: 0, pending: 1 },
  });
  assert.equal(o.kind, 'partial');
  assert.equal(o.headline, '1 of 2 connected');
  assert.match(o.detail, /Rockey Sheikh/);
});

test('handshakeOutcome: every sender connected is ok', () => {
  assert.equal(handshakeOutcome({ senders: [{ state: 'connected' }] }).kind, 'ok');
});

test('handshakeOutcome: an error beats everything else', () => {
  const o = handshakeOutcome({ senders: [{ state: 'connected' }], error: 'browser died' });
  assert.equal(o.kind, 'error');
  assert.equal(o.detail, 'browser died');
});

test('handshakeStepView: senders that were already 1st owe no accept', () => {
  const senders = [{ profileId: 'a', state: 'connected' }, { profileId: 'b', state: 'connected' }];
  assert.equal(handshakeStepView(senders, null, new Set()).needsAccept, false);
  assert.equal(handshakeStepView(senders, null, new Set(['b'])).needsAccept, true);
});

test('handshakeStepView: needsAccept is unknown until something has moved', () => {
  assert.equal(handshakeStepView([{ state: 'pending' }]).needsAccept, null);
});
