/**
 * Phase 11.3 Wave 0 — RED test for shouldWriteReply pure predicate.
 *
 * Will fail with ERR_MODULE_NOT_FOUND until Plan 11.3-02 creates
 * src/linkedin/check-dms.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldWriteReply } from '../src/linkedin/check-dms.js';

test('shouldWriteReply: returns true when Reply column is empty', () => {
  assert.equal(shouldWriteReply({ Reply: '' }, { text: 'hi' }), true);
});

test('shouldWriteReply: returns true when Reply column is missing', () => {
  assert.equal(shouldWriteReply({}, { text: 'hi' }), true);
});

test('shouldWriteReply: returns true when status row is null/undefined', () => {
  assert.equal(shouldWriteReply(null, { text: 'hi' }), true);
  assert.equal(shouldWriteReply(undefined, { text: 'hi' }), true);
});

test('shouldWriteReply: returns false when Reply already "yes" (preserve manual edits)', () => {
  assert.equal(shouldWriteReply({ Reply: 'yes' }, { text: 'newer' }), false);
});

test('shouldWriteReply: case-insensitive on Reply value', () => {
  assert.equal(shouldWriteReply({ Reply: 'YES' }, { text: 'hi' }), false);
  assert.equal(shouldWriteReply({ Reply: 'Yes' }, { text: 'hi' }), false);
});

test('shouldWriteReply: whitespace-tolerant on Reply value', () => {
  assert.equal(shouldWriteReply({ Reply: ' yes ' }, { text: 'hi' }), false);
});
