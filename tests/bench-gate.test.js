import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldContinueTurn } from '../src/bench-gate.js';

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
