import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _shouldHoldIntros, _shouldQueueAutoAccept } from '../src/linkedin/auto-intro.js';

// v2.96 — connect-to-primary self-heal gate decisions.

test('_shouldHoldIntros: holds when primary not connected', () => {
  assert.equal(_shouldHoldIntros({ connected: false, degree: '2nd' }), true);
});

test('_shouldHoldIntros: proceeds when primary connected', () => {
  assert.equal(_shouldHoldIntros({ connected: true, degree: '1st' }), false);
});

test('_shouldHoldIntros: proceeds (does not hold) when result missing/undefined', () => {
  // A thrown/absent result must not silently hold — the caller falls through
  // to attempting intros, so the decision helper returns false.
  assert.equal(_shouldHoldIntros(undefined), false);
  assert.equal(_shouldHoldIntros(null), false);
});

test('_shouldHoldIntros: connected===undefined (unknown) does not hold', () => {
  // Only an explicit connected===false holds; an ambiguous read proceeds.
  assert.equal(_shouldHoldIntros({ degree: 'unknown' }), false);
});

test('_shouldQueueAutoAccept: queues when enabled + connect freshly sent', () => {
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: true, connectAttempted: true, connectResult: 'sent',
  }), true);
});

test('_shouldQueueAutoAccept: no queue when auto-accept disabled', () => {
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: false, connectAttempted: true, connectResult: 'sent',
  }), false);
});

test('_shouldQueueAutoAccept: no queue when no connect was attempted', () => {
  // Already-connected (or pending re-check with attemptConnect=false): nothing
  // to accept, so no task.
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: true, connectAttempted: false, connectResult: undefined,
  }), false);
});

test('_shouldQueueAutoAccept: STILL queues when the connect "failed" — the primary list arbitrates', () => {
  // 2026-06-16 "Micha": her primary profile page didn't render (encoded URL /
  // rate-limit) so sendConnectionRequest threw "Connect button not found" — yet
  // her invite from a prior run was sitting pending in the primary's inbox. A
  // 'failed' verdict must NOT drop the account: we queue the accept and let the
  // primary's received list (precise matching) decide. A genuine no-invite is
  // matched against nothing and the runner marks it 'skipped' — safe.
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: true, connectAttempted: true, connectResult: 'failed',
  }), true);
});

test('_shouldQueueAutoAccept: queues when the invite was ALREADY pending', () => {
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: true, connectAttempted: true, connectResult: 'already_pending',
  }), true);
});

test('_shouldQueueAutoAccept: queues regardless of connectResult once a connect was attempted', () => {
  // connectResult is no longer part of the decision — only "did we try to connect".
  for (const r of ['sent', 'already_pending', 'failed', undefined]) {
    assert.equal(_shouldQueueAutoAccept({ autoAcceptPrimary: true, connectAttempted: true, connectResult: r }), true, `result=${r}`);
  }
});

test('_shouldQueueAutoAccept: never queues when auto-accept is disabled, whatever happened', () => {
  for (const r of ['sent', 'already_pending', 'failed']) {
    assert.equal(_shouldQueueAutoAccept({ autoAcceptPrimary: false, connectAttempted: true, connectResult: r }), false, `result=${r}`);
  }
});

test('_shouldQueueAutoAccept: tolerates missing argument', () => {
  assert.equal(_shouldQueueAutoAccept(), false);
});
