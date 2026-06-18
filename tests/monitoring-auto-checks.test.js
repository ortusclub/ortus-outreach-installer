import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoFireCheck } from '../src/monitoring-auto-checks.js';

const T0 = Date.parse('2026-06-18T12:00:00Z');
const past = new Date(T0 - 1000).toISOString();
const future = new Date(T0 + 60_000).toISOString();

test('fires when enabled (or unset) and nextCheckAt is due', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: past, now: T0 }), true);
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: undefined, nextCheckAt: past, now: T0 }), true);
});

test('does not fire when not yet due', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: future, now: T0 }), false);
});

test('does not fire when disabled, even if overdue', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: false, nextCheckAt: past, now: T0 }), false);
});

test('does not fire with missing / invalid nextCheckAt', () => {
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: null, now: T0 }), false);
  assert.equal(shouldAutoFireCheck({ autoChecksEnabled: true, nextCheckAt: 'nonsense', now: T0 }), false);
});
