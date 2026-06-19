import test from 'node:test';
import assert from 'node:assert/strict';
import { isHiddenSection } from '../public/js/account-guardrails.mjs';

// Accounts under the "Construction" section header in column A of the SoO must
// never appear in the GoLogin launcher window. Section comes straight from the
// SoO (handleGetSoO derives it from the column-A header rows) — no invented data.

test('Construction section → hidden', () => {
  assert.equal(isHiddenSection({ section: 'Construction' }), true);
});

test('section match is case-insensitive', () => {
  assert.equal(isHiddenSection({ section: 'construction' }), true);
  assert.equal(isHiddenSection({ section: 'CONSTRUCTION' }), true);
});

test('section match tolerates extra words around the header label', () => {
  assert.equal(isHiddenSection({ section: 'Construction Accounts' }), true);
  assert.equal(isHiddenSection({ section: '🚧 Construction' }), true);
});

test('Pool / Unassigned sections are NOT hidden', () => {
  assert.equal(isHiddenSection({ section: 'Pool Accounts Unassigned' }), false);
});

test('a normal team section is NOT hidden', () => {
  assert.equal(isHiddenSection({ section: 'Team A' }), false);
});

test('empty / missing section → not hidden', () => {
  assert.equal(isHiddenSection({ section: '' }), false);
  assert.equal(isHiddenSection({}), false);
});

test('no SoO record → not hidden (cannot identify section, so show it)', () => {
  assert.equal(isHiddenSection(null), false);
  assert.equal(isHiddenSection(undefined), false);
});
