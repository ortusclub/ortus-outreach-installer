import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelayMultiplier } from '../src/resource-monitor.js';

test('message_only mode → 1 regardless of throttle', () => {
  assert.equal(
    computeDelayMultiplier({ mode: 'message_only', profileCount: 1, throttleActive: true, throttleMultiplier: 2 }),
    1,
  );
  assert.equal(
    computeDelayMultiplier({ mode: 'message_only', profileCount: 5, throttleActive: false, throttleMultiplier: 2 }),
    1,
  );
});

test('single-profile not throttled → 2 (existing behavior preserved)', () => {
  assert.equal(
    computeDelayMultiplier({ mode: 'connect_only', profileCount: 1, throttleActive: false, throttleMultiplier: 2 }),
    2,
  );
});

test('multi-profile not throttled → 1', () => {
  assert.equal(
    computeDelayMultiplier({ mode: 'connect_only', profileCount: 3, throttleActive: false, throttleMultiplier: 2 }),
    1,
  );
});

test('single-profile throttled → 4 (stack: 2x * 2x per D-08)', () => {
  assert.equal(
    computeDelayMultiplier({ mode: 'connect_only', profileCount: 1, throttleActive: true, throttleMultiplier: 2 }),
    4,
  );
});

test('multi-profile throttled → 2', () => {
  assert.equal(
    computeDelayMultiplier({ mode: 'connect_only', profileCount: 3, throttleActive: true, throttleMultiplier: 2 }),
    2,
  );
});
