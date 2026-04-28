import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBetweenBatchWaitMs } from '../src/campaign.js';

// Pure logic — given N batches/hour and a batch duration, return the wait time
// between batches such that we hit the rate target. Math: hour/N - duration,
// with a 60-second floor (MIN_BETWEEN_BATCHES_MS).

test('2 batches/hour with zero duration waits 30 minutes', () => {
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 2, batchDurationMs: 0 });
  assert.equal(ms, 30 * 60 * 1000);
});

test('4 batches/hour with zero duration waits 15 minutes', () => {
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 4, batchDurationMs: 0 });
  assert.equal(ms, 15 * 60 * 1000);
});

test('2 batches/hour with 5-minute duration waits 25 minutes', () => {
  const ms = computeBetweenBatchWaitMs({
    batchesPerHour: 2,
    batchDurationMs: 5 * 60 * 1000,
  });
  assert.equal(ms, 25 * 60 * 1000);
});

test('returns 60s floor when batch duration exceeds slot', () => {
  // batchesPerHour=2 → slot=30min; batchDuration=60min → slot-duration < 0 → clamped to 60s floor
  const ms = computeBetweenBatchWaitMs({
    batchesPerHour: 2,
    batchDurationMs: 60 * 60 * 1000,
  });
  assert.equal(ms, 60 * 1000, `expected 60s floor, got ${ms}`);
});

test('batchesPerHour is clamped to max 6 (10-minute slots)', () => {
  // Passing 100 is treated as 6 due to Math.min(6, ...) clamp.
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 100, batchDurationMs: 0 });
  assert.equal(ms, (3600 / 6) * 1000); // 600_000 ms = 10 minutes
});

test('batchesPerHour defaults to 2 when invalid (non-numeric string)', () => {
  // Number('bad') = NaN, NaN || 2 = 2, Math.max(1, Math.min(6, 2)) = 2, slot = 30 min
  const ms = computeBetweenBatchWaitMs({ batchesPerHour: 'bad', batchDurationMs: 0 });
  assert.equal(ms, 30 * 60 * 1000);
});
