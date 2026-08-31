import test from 'node:test';
import assert from 'node:assert/strict';
import { isInterruption, interruptionMatches, interruptionCopy } from '../src/runtime-interruption.js';

// The measured case: a heartbeat written at 12:38 while the campaign was alive
// and mid-acceptance-check, rendered by the card as a stop nobody performed.
const HEARTBEAT = {
  active: true,
  reason: 'active-run',
  recordedAt: '2026-08-28T10:38:15.272Z',
  phase: 'monitoring',
  campaignId: 'cmp_13s04kukmt7b0ro6',
};

test('an active-run heartbeat is never an interruption', () => {
  assert.equal(isInterruption(HEARTBEAT), false);
});

test('a real interruption still is one', () => {
  for (const reason of ['system-sleep', 'app-quit', 'campaign-stop-timeout', 'unexpected-exit']) {
    assert.equal(isInterruption({ ...HEARTBEAT, reason }), true, reason);
  }
});

test('an inactive or missing journal is not an interruption', () => {
  assert.equal(isInterruption(null), false);
  assert.equal(isInterruption({ active: false, reason: 'app-quit' }), false);
});

test('a journal only speaks for the campaign it names', () => {
  assert.equal(interruptionMatches(HEARTBEAT, 'cmp_13s04kukmt7b0ro6'), true);
  assert.equal(interruptionMatches(HEARTBEAT, 'legacy-singleton'), false);
  // Both sides fall back to the singleton, so a plain local campaign matches.
  assert.equal(interruptionMatches({ active: true, reason: 'app-quit' }, ''), true);
});

test('an unknown reason never invents a cause', () => {
  assert.equal(interruptionCopy({ reason: 'unexpected-exit' }).title, 'Stopped because this Mac became unavailable');
  assert.equal(interruptionCopy({ reason: 'something-new' }).title, 'Stopped, and the app could not record why');
});
