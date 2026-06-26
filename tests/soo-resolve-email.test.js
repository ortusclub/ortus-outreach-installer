import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSoOEmail } from '../src/soo-writer.js';

const POOL = [
  'don.matugas@ortus.solutions',
  'roe.aguirre@ortus.solutions',
  'justin.caleb@ortus.solutions',
  'maria.lopez@ortus.solutions',
];

test('exact match wins and returns the sheet spelling', () => {
  const r = resolveSoOEmail('don.matugas@ortus.solutions', POOL);
  assert.deepEqual(r, { email: 'don.matugas@ortus.solutions', exact: true, score: 1 });
});

test('exact match is case-insensitive and whitespace-insensitive', () => {
  const r = resolveSoOEmail('  DON.MATUGAS@ortus.solutions ', POOL);
  assert.equal(r.exact, true);
  assert.equal(r.email, 'don.matugas@ortus.solutions');
});

test('typo ".solution" vs ".solutions" resolves fuzzily (≥90%) and is not exact', () => {
  const r = resolveSoOEmail('don.matugas@ortus.solution', POOL);
  assert.equal(r.exact, false);
  assert.equal(r.email, 'don.matugas@ortus.solutions');
  assert.ok(r.score >= 0.9, `score ${r.score}`);
});

test('a totally different label resolves to null (nothing close enough)', () => {
  assert.equal(resolveSoOEmail('test3', POOL), null);
  assert.equal(resolveSoOEmail('sharingprofile', POOL), null);
});

test('default threshold is 93%: a ~91% near-miss is rejected', () => {
  // 'maria.lopez@ortus.solutions' (27 chars) with 2 edits ≈ 0.926 < 0.93 → null
  const r = resolveSoOEmail('marja.lopz@ortus.solutions', POOL);
  assert.equal(r, null);
});

test('skip-on-doubt: two near-identical accounts resolve to ambiguous, never a guess', () => {
  const twins = ['jon.smith@ortus.solutions', 'jan.smith@ortus.solutions'];
  const r = resolveSoOEmail('jen.smith@ortus.solutions', twins);
  assert.equal(r.ambiguous, true);
  assert.equal(r.email, undefined);
});

test('empty / missing input is null, never throws', () => {
  assert.equal(resolveSoOEmail('', POOL), null);
  assert.equal(resolveSoOEmail('  ', POOL), null);
  assert.equal(resolveSoOEmail('don.matugas@ortus.solutions', []), null);
  assert.equal(resolveSoOEmail('x@y.z', null), null);
});

test('blank cells in the pool are ignored', () => {
  const r = resolveSoOEmail('maria.lopez@ortus.solutions', ['', '   ', 'maria.lopez@ortus.solutions']);
  assert.equal(r.exact, true);
});
