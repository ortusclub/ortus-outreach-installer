import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldContinueTurn, shouldRequeue } from '../src/bench-gate.js';

test('stops the turn when the profile was benched mid-turn', () => {
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: false, benched: true }), false);
});
test('continues when not benched/limited/aborted', () => {
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: false, benched: false }), true);
});
test('stops on abort / orphan / weekly limit (existing behavior preserved)', () => {
  assert.equal(shouldContinueTurn({ abort: true, orphan: false, weeklyLimited: false, benched: false }), false);
  assert.equal(shouldContinueTurn({ abort: false, orphan: true, weeklyLimited: false, benched: false }), false);
  assert.equal(shouldContinueTurn({ abort: false, orphan: false, weeklyLimited: true, benched: false }), false);
});

test('shouldRequeue: only when not already queued and not mid-turn', () => {
  assert.equal(shouldRequeue({ inQueue: false, beingRun: false }), true);
  assert.equal(shouldRequeue({ inQueue: true, beingRun: false }), false);
  assert.equal(shouldRequeue({ inQueue: false, beingRun: true }), false);
  assert.equal(shouldRequeue({ inQueue: true, beingRun: true }), false);
});

import { canAddProfile } from '../src/bench-gate.js';

test('canAddProfile rejects empty + duplicates, allows new', () => {
  assert.equal(canAddProfile(['a'], 'a'), false);
  assert.equal(canAddProfile(['a'], ''), false);
  assert.equal(canAddProfile(['a'], 'b'), true);
  assert.equal(canAddProfile(null, 'b'), true);
});
