import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome } from '../src/linkedin/outcome-classify.js';

test('connection_sent → Request / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'connection_sent' }),
    { phase: 'Request', outcome: 'sent', reason: '' });
});

test('status_accepted → Accept / accepted', () => {
  assert.deepEqual(classifyOutcome({ action: 'status_accepted' }),
    { phase: 'Accept', outcome: 'accepted', reason: '' });
});

test('already_connected → Accept / accepted', () => {
  assert.deepEqual(classifyOutcome({ action: 'already_connected' }),
    { phase: 'Accept', outcome: 'accepted', reason: '' });
});

test('message_sent (introduce_back) → Intro / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'message_sent', mode: 'introduce_back' }),
    { phase: 'Intro', outcome: 'sent', reason: '' });
});

test('message_sent (message_only) → DM / sent', () => {
  assert.deepEqual(classifyOutcome({ action: 'message_sent', mode: 'message_only' }),
    { phase: 'DM', outcome: 'sent', reason: '' });
});

test('skip with HTTP 429 reason → rate_limited (normalised label)', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Rate-limited (HTTP 429) — confirming…' }),
    { phase: 'Request', outcome: 'rate_limited', reason: 'Rate-limited (HTTP 429)' });
});

test('skip Weekly limit reached → parked / Account', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Weekly limit reached' }),
    { phase: 'Account', outcome: 'parked', reason: 'Weekly limit reached' });
});

test('skip with unrecognised reason → skipped, reason preserved', () => {
  assert.deepEqual(classifyOutcome({ action: 'skip', reason: 'Connect modal opened for wrong person' }),
    { phase: 'Request', outcome: 'skipped', reason: 'Connect modal opened for wrong person' });
});

test('error in CC+IC intro → error / Intro', () => {
  assert.deepEqual(classifyOutcome({ action: 'error', reason: 'Failed — Primary not in your connections', mode: 'connect_and_introduce' }),
    { phase: 'Intro', outcome: 'error', reason: 'Failed — Primary not in your connections' });
});

test('unknown action → skipped/unknown, never throws', () => {
  const r = classifyOutcome({ action: 'totally_new' });
  assert.equal(r.outcome, 'skipped');
});

test('no args → never throws', () => {
  assert.doesNotThrow(() => classifyOutcome());
  assert.doesNotThrow(() => classifyOutcome({}));
});
