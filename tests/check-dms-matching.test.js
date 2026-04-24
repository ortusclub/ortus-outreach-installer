/**
 * Phase 11.3 Wave 0 — RED test for matchConversationToSheet pure function.
 *
 * Will fail with ERR_MODULE_NOT_FOUND until Plan 11.3-02 creates
 * src/linkedin/check-dms.js. That's the correct TDD RED signal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { matchConversationToSheet } from '../src/linkedin/check-dms.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHEET_ROWS = JSON.parse(
  await readFile(join(__dirname, 'fixtures/sheet-rows.json'), 'utf-8')
);

// Filter to Antonio's rows (per-profile scoping emulation)
const antonioRows = SHEET_ROWS.filter(r => r['Account Used'] === 'Antonio' && r.Message === 'sent');

function conv(firstName, lastName) {
  return { participant: { firstName, lastName } };
}

test('matchConversationToSheet: exact first+last match returns the row', () => {
  const result = matchConversationToSheet(conv('Gurneet', 'Jodhka'), antonioRows);
  assert.equal(result.reason, undefined);
  assert.ok(result.match);
  assert.equal(result.match.firstName, 'Gurneet');
  assert.equal(result.match.lastName, 'Jodhka');
});

test('matchConversationToSheet: case-insensitive + whitespace-tolerant', () => {
  const result = matchConversationToSheet(conv('  gurneet  ', 'JODHKA'), antonioRows);
  assert.ok(result.match);
});

test('matchConversationToSheet: unmatched conversation returns reason=unmatched', () => {
  const result = matchConversationToSheet(conv('No', 'One'), antonioRows);
  assert.equal(result.match, null);
  assert.equal(result.reason, 'unmatched');
});

test('matchConversationToSheet: ambiguous (same name on two rows) returns reason=ambiguous with candidates', () => {
  const result = matchConversationToSheet(conv('John', 'Smith'), antonioRows);
  assert.equal(result.match, null);
  assert.equal(result.reason, 'ambiguous');
  assert.ok(Array.isArray(result.candidates));
  assert.equal(result.candidates.length, 2);
});

test('matchConversationToSheet: respects per-profile scoping (Patricia row not in Antonio candidate set)', () => {
  // Caller is responsible for filtering by Account Used BEFORE calling this function.
  // This test documents that contract.
  const patriciaOnly = SHEET_ROWS.filter(r => r['Account Used'] === 'Patricia');
  const result = matchConversationToSheet(conv('Gurneet', 'Jodhka'), patriciaOnly);
  assert.equal(result.match, null);
  assert.equal(result.reason, 'unmatched');
});
