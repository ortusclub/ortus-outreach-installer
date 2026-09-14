import test from 'node:test';
import assert from 'node:assert/strict';
import { localStopStatus } from '../src/local-stop-receipt.js';

test('finished loop does not hide pending closure or failed tracking cleanup', () => {
  const receipt = { generation: 1, requestedAt: 123, tracking: { ok: true }, browsersClosed: false };
  const state = { generation: 1, running: false };
  assert.equal(localStopStatus(receipt, state).stopping, true);
  receipt.browsersClosed = true;
  receipt.tracking = { ok: false, error: 'fixture write failure' };
  assert.equal(localStopStatus(receipt, state).stopConfirmed, false);
  receipt.tracking = { ok: true };
  assert.equal(localStopStatus(receipt, state).stopConfirmed, true);
  assert.equal(localStopStatus(receipt, { generation: 1, running: true }).stopConfirmed, false);
  receipt.unverifiedScopes = ['manual acceptance check'];
  assert.equal(localStopStatus(receipt, state).stopConfirmed, false);
  assert.match(localStopStatus(receipt, state).stopError, /manual acceptance check/);
});

test('an old receipt cannot label the new run stopped', () => {
  assert.equal(localStopStatus({ generation: 1, browsersClosed: true, tracking: { ok: true } }, { generation: 2, running: true }), null);
});
