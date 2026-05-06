// Unit coverage for the pure helpers that drive the batch loop.
// Does not launch browsers. Does not run a real campaign.
//
// v2.11.0: dropped batchesPerHour. The per-profile turn cooldown is now a
// fixed 6-min floor inside startCampaign (not a pure helper), so there is
// nothing left to unit-test for spacing math. Queue rotation is the primary
// pacer and its correctness is covered by the worker-pool integration paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shouldCloseBetweenBatches } from '../src/campaign.js';

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

test('v2.11.0: campaign.js declares fixed 6-min turn cooldown floor', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(src, /TURN_COOLDOWN_FLOOR_MS\s*=\s*6\s*\*\s*60\s*\*\s*1000/);
});

test('v2.11.0: campaign.js no longer reads batchesPerHour for cooldown math', () => {
  const src = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /3600\s*\/\s*batchesPerHour/);
});
