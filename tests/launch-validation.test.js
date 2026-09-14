import test from 'node:test';
import assert from 'node:assert/strict';
import { launchValidationError } from '../src/launch-validation.js';

test('rejects a connect campaign with zero accounts', () => {
  assert.match(launchValidationError({ mode: 'connect_only', profileIds: [], targetCount: 4 }), /at least one/i);
});

test('rejects a cold campaign with zero actionable targets', () => {
  assert.match(launchValidationError({ mode: 'connect_only', profileIds: ['p1'], targetCount: 0 }), /No actionable leads/i);
});

test('allows a valid cold campaign', () => {
  assert.equal(launchValidationError({ mode: 'connect_only', profileIds: ['p1'], targetCount: 4 }), null);
});

test('derived-sender modes may begin intake without explicit profile ids', () => {
  assert.equal(launchValidationError({ mode: 'message_only', profileIds: [], targetCount: 4 }), null);
});
