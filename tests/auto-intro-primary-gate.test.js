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

test('_shouldQueueAutoAccept: no queue when the connect send failed', () => {
  assert.equal(_shouldQueueAutoAccept({
    autoAcceptPrimary: true, connectAttempted: true, connectResult: 'failed',
  }), false);
});

test('_shouldQueueAutoAccept: tolerates missing argument', () => {
  assert.equal(_shouldQueueAutoAccept(), false);
});
