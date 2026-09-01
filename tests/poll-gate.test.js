import { test } from 'node:test';
import assert from 'node:assert';
import { shouldPoll } from '../public/js/pollgate.mjs';

test('a running campaign polls', () => {
  assert.equal(shouldPoll({ running: true, state: undefined }), true);
});

test('a monitoring campaign polls even though it is not running', () => {
  // The whole bug: monitoring is not `running`, so the old gate never
  // started the interval and the card froze at its page-load render.
  assert.equal(shouldPoll({ running: false, state: 'monitoring' }), true);
});

test('an idle campaign does not poll', () => {
  assert.equal(shouldPoll({ running: false, state: undefined }), false);
});

test('a finished campaign does not poll', () => {
  assert.equal(shouldPoll({ running: false, state: 'done' }), false);
});

test('a missing status does not poll', () => {
  assert.equal(shouldPoll(null), false);
  assert.equal(shouldPoll(undefined), false);
});
