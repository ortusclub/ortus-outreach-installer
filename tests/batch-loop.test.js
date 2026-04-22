// Phase 11.2 — unit coverage for the pure helpers that drive the new batch loop.
// Does not launch browsers. Does not run a real campaign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeBetweenBatchWaitMs, shouldCloseBetweenBatches } from '../src/campaign.js';

test('computeBetweenBatchWaitMs: 2 bph, zero duration → 30min (1_800_000)', () => {
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 2, batchDurationMs: 0 }), 1_800_000);
});

test('computeBetweenBatchWaitMs: 6 bph, zero duration → 10min (600_000)', () => {
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 6, batchDurationMs: 0 }), 600_000);
});

test('computeBetweenBatchWaitMs: 3 bph, zero duration → 20min', () => {
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 3, batchDurationMs: 0 }), 1_200_000);
});

test('computeBetweenBatchWaitMs: subtracts batch duration from target spacing', () => {
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 2, batchDurationMs: 600_000 }), 1_200_000);
});

test('computeBetweenBatchWaitMs: applies 60s floor when target < duration', () => {
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 2, batchDurationMs: 1_800_000 }), 60_000);
  assert.equal(computeBetweenBatchWaitMs({ batchesPerHour: 6, batchDurationMs: 700_000 }), 60_000);
});

test('shouldCloseBetweenBatches: 14min below default 15min → false', () => {
  assert.equal(shouldCloseBetweenBatches({ waitMs: 14 * 60_000 }), false);
});

test('shouldCloseBetweenBatches: 16min above default 15min → true', () => {
  assert.equal(shouldCloseBetweenBatches({ waitMs: 16 * 60_000 }), true);
});

test('shouldCloseBetweenBatches: explicit threshold overrides default', () => {
  assert.equal(shouldCloseBetweenBatches({ waitMs: 16 * 60_000, closeGapMin: 30 }), false);
  assert.equal(shouldCloseBetweenBatches({ waitMs: 31 * 60_000, closeGapMin: 30 }), true);
});

test('campaign.js declares BATCH_SIZE = 5 as a module-level constant', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /const\s+BATCH_SIZE\s*=\s*5\s*;/);
});

test('campaign.js no longer contains the session-break branch (D-04 deletion)', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /SESSION_BREAK_EVERY/);
  assert.doesNotMatch(src, /Session break:/);
});

test('campaign.js no longer contains the batchModes Set (D-01 unification)', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /batchModes\s*=\s*new Set/);
});
