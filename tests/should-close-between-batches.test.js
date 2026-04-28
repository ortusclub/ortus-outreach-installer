import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCloseBetweenBatches } from '../src/campaign.js';

// Pure helper — decides whether to close the browser between batches.
// Uses strict `>` comparison: waitMs must strictly exceed threshold * 60 * 1000.

test('long wait triggers close (10 min wait, 5 min threshold)', () => {
  const result = shouldCloseBetweenBatches({
    waitMs: 10 * 60 * 1000,
    closeGapMin: 5,
  });
  assert.equal(result, true);
});

test('short wait does not trigger close (2 min wait, 5 min threshold)', () => {
  const result = shouldCloseBetweenBatches({
    waitMs: 2 * 60 * 1000,
    closeGapMin: 5,
  });
  assert.equal(result, false);
});

test('exactly-at-threshold returns false (strict > comparison)', () => {
  // waitMs === threshold * 60 * 1000 → 5 > 5 is false
  const result = shouldCloseBetweenBatches({
    waitMs: 5 * 60 * 1000,
    closeGapMin: 5,
  });
  assert.equal(result, false);
});
