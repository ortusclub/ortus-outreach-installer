import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide429 } from '../src/throttle-policy.js';

test('First episode (cooldownsSoFar=0) → action: cooldown, waitMs: 1800000', () => {
  const result = decide429({ consecutive429s: 1, cooldownsSoFar: 0 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Second episode (cooldownsSoFar=1) → action: cooldown, waitMs: 3600000', () => {
  const result = decide429({ consecutive429s: 2, cooldownsSoFar: 1 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 3600000);
});

test('Third episode (cooldownsSoFar=2) → action: park, waitMs: 0', () => {
  const result = decide429({ consecutive429s: 3, cooldownsSoFar: 2 });
  assert.equal(result.action, 'park');
  assert.equal(result.waitMs, 0);
});

test('High value (cooldownsSoFar=10) → action: park, waitMs: 0', () => {
  const result = decide429({ consecutive429s: 5, cooldownsSoFar: 10 });
  assert.equal(result.action, 'park');
  assert.equal(result.waitMs, 0);
});

test('Missing cooldownsSoFar (undefined) → action: cooldown, waitMs: 1800000', () => {
  const result = decide429({ consecutive429s: 1 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Missing consecutive429s (undefined) → same as first episode', () => {
  // consecutive429s unused in logic but accepted
  const result = decide429({ cooldownsSoFar: 0 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Both fields missing (empty call) → action: cooldown, waitMs: 1800000', () => {
  const result = decide429({});
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Zero values → first episode behavior', () => {
  const result = decide429({ consecutive429s: 0, cooldownsSoFar: 0 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Negative cooldownsSoFar clamped to 0 → first episode', () => {
  const result = decide429({ consecutive429s: 1, cooldownsSoFar: -5 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Negative consecutive429s (allowed but unused) → behavior unchanged', () => {
  const result = decide429({ consecutive429s: -1, cooldownsSoFar: 0 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Boundary: cooldownsSoFar exactly 2 → park', () => {
  const result = decide429({ consecutive429s: 0, cooldownsSoFar: 2 });
  assert.equal(result.action, 'park');
  assert.equal(result.waitMs, 0);
});

test('Boundary: cooldownsSoFar exactly 1 → cooldown 60 min', () => {
  const result = decide429({ consecutive429s: 0, cooldownsSoFar: 1 });
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 3600000);
});

test('No arguments at all (undefined) → defaults to first episode', () => {
  const result = decide429();
  assert.equal(result.action, 'cooldown');
  assert.equal(result.waitMs, 1800000);
});

test('Return object has expected shape', () => {
  const result = decide429({ cooldownsSoFar: 0 });
  assert.ok('action' in result);
  assert.ok('waitMs' in result);
  assert.equal(typeof result.action, 'string');
  assert.equal(typeof result.waitMs, 'number');
});

test('Action values are exactly one of cooldown or park', () => {
  const r1 = decide429({ cooldownsSoFar: 0 });
  assert.ok(['cooldown', 'park'].includes(r1.action));

  const r2 = decide429({ cooldownsSoFar: 2 });
  assert.ok(['cooldown', 'park'].includes(r2.action));
});
