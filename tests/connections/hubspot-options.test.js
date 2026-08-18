import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseValue, mergeOptions, verifyReadBack } from '../../src/connections/hubspot-options.js';

const opts = (...vals) => vals.map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false }));

test('normaliseValue trims and lowercases', () => {
  assert.equal(normaliseValue('  Pat.Yanguas@Ortus.Solutions '), 'pat.yanguas@ortus.solutions');
});

test('appends a missing value with the next displayOrder', () => {
  const existing = opts('a@ortus.solutions', 'b@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['c@ortus.solutions']);
  assert.deepEqual(added, ['c@ortus.solutions']);
  assert.equal(options.length, 3);
  assert.deepEqual(options[2], {
    label: 'c@ortus.solutions', value: 'c@ortus.solutions', displayOrder: 2, hidden: false,
  });
});

test('leaves every existing option untouched and in order', () => {
  const existing = opts('a@ortus.solutions', 'b@ortus.solutions');
  const { options } = mergeOptions(existing, ['c@ortus.solutions']);
  assert.deepEqual(options.slice(0, 2), existing);
});

test('is idempotent for a value that is already present', () => {
  const existing = opts('a@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['A@Ortus.Solutions']);
  assert.deepEqual(added, []);
  assert.deepEqual(options, existing);
});

test('de-duplicates values within one call', () => {
  const existing = opts('a@ortus.solutions');
  const { options, added } = mergeOptions(existing, ['c@ortus.solutions', 'C@ortus.solutions']);
  assert.deepEqual(added, ['c@ortus.solutions']);
  assert.equal(options.length, 2);
});

test('ignores blank values', () => {
  const existing = opts('a@ortus.solutions');
  const { added } = mergeOptions(existing, ['', '   ', null, undefined]);
  assert.deepEqual(added, []);
});

test('verifyReadBack passes when every added value is present and the count matches', () => {
  const before = opts('a@ortus.solutions');
  const after = opts('a@ortus.solutions', 'c@ortus.solutions');
  assert.deepEqual(verifyReadBack(before, after, ['c@ortus.solutions']), { ok: true, missing: [] });
});

test('verifyReadBack fails when an added value is absent', () => {
  const before = opts('a@ortus.solutions');
  const after = opts('a@ortus.solutions');
  const r = verifyReadBack(before, after, ['c@ortus.solutions']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['c@ortus.solutions']);
});

test('verifyReadBack fails when the total count does not equal before + added', () => {
  const before = opts('a@ortus.solutions', 'b@ortus.solutions');
  const after = opts('a@ortus.solutions', 'c@ortus.solutions');   // b vanished
  assert.equal(verifyReadBack(before, after, ['c@ortus.solutions']).ok, false);
});
