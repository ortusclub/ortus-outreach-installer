import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupSoO } from '../public/js/account-guardrails.mjs';

// GoLogin profile names are usually the bare account email, but some carry
// decoration: a " [1]" duplicate suffix, a stray leading invisible char, etc.
// The SoO is keyed by the bare lowercased email, so the lookup must find the
// email embedded in the name — otherwise the tile shows FREE for a real account.
const SOO = {
  'ryan.ceballo@ortus.solutions': { email: 'ryan.ceballo@ortus.solutions', ccCredits: 'In Use' },
  'anthony.ricaplaza@ortus.solutions': { email: 'anthony.ricaplaza@ortus.solutions', ccCredits: 'Available' },
};

test('exact name (bare email) matches', () => {
  assert.equal(lookupSoO(SOO, 'ryan.ceballo@ortus.solutions').ccCredits, 'In Use');
});

test('case-insensitive', () => {
  assert.equal(lookupSoO(SOO, 'Ryan.Ceballo@Ortus.Solutions').ccCredits, 'In Use');
});

test('" [1]" duplicate suffix still matches (the rafaela/ryan bug)', () => {
  assert.equal(lookupSoO(SOO, 'ryan.ceballo@ortus.solutions [1]').ccCredits, 'In Use');
});

test('stray leading invisible char still matches', () => {
  assert.equal(lookupSoO(SOO, '‎anthony.ricaplaza@ortus.solutions').ccCredits, 'Available');
});

test('surrounding text / display name with email matches', () => {
  assert.equal(lookupSoO(SOO, 'Ryan Ceballo <ryan.ceballo@ortus.solutions>').ccCredits, 'In Use');
});

test('a name with no email and no exact key → null', () => {
  assert.equal(lookupSoO(SOO, 'zoominfo_ii'), null);
  assert.equal(lookupSoO(SOO, 'profile 196'), null);
});

test('an embedded email not present in the SoO → null (no false match)', () => {
  assert.equal(lookupSoO(SOO, 'someone.else@ortus.solutions [2]'), null);
});

test('empty / missing args → null', () => {
  assert.equal(lookupSoO(SOO, ''), null);
  assert.equal(lookupSoO(null, 'ryan.ceballo@ortus.solutions'), null);
});
