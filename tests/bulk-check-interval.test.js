import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBulkCheckIntervalMs } from '../src/campaign.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;

test('configured cadence drives the bulk-check interval', () => {
  assert.equal(resolveBulkCheckIntervalMs(60), 60 * 60_000);
  assert.equal(resolveBulkCheckIntervalMs(15), 15 * 60_000);
  assert.equal(resolveBulkCheckIntervalMs('45'), 45 * 60_000);
});

test('unset / invalid cadence falls back to the 6h constant', () => {
  assert.equal(resolveBulkCheckIntervalMs(undefined), SIX_HOURS);
  assert.equal(resolveBulkCheckIntervalMs(null), SIX_HOURS);
  assert.equal(resolveBulkCheckIntervalMs(0), SIX_HOURS);
  assert.equal(resolveBulkCheckIntervalMs(-5), SIX_HOURS);
  assert.equal(resolveBulkCheckIntervalMs('nope'), SIX_HOURS);
  assert.equal(resolveBulkCheckIntervalMs(NaN), SIX_HOURS);
});

test('explicit fallback override is honored', () => {
  assert.equal(resolveBulkCheckIntervalMs(undefined, 1234), 1234);
  assert.equal(resolveBulkCheckIntervalMs(30, 1234), 30 * 60_000);
});
