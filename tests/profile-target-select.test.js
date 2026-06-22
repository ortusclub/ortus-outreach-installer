import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickTargetProfile } from '../src/linkedin/helpers.js';

// Real data from the 2026-06-22 MEGADECK run (lead "Candice L.", sender account
// pravin.bisen). LinkedIn's Voyager `included` array carried BOTH the viewer's
// own profile (Pravin, listed FIRST) and the lead's (Candice). Taking the first
// profile entity grabbed the SENDER → name-mismatch → a legit lead got skipped.
const INCLUDED = [
  { entityUrn: 'urn:li:fsd_profile:ACoAAFX1U3kBzw97hR_mFZDuzYkrNKCte8LmFUM', firstName: 'Pravin', lastName: 'Bisen', publicIdentifier: 'pravin-bisen-449b78342' },
  { entityUrn: 'urn:li:fsd_profile:ACoAABn2UGQBIQYPJRa4KkKx6sTTPLyVuJI1Kok', firstName: 'Candice', lastName: 'L.', publicIdentifier: 'candice-l-744a57101' },
];

test('pickTargetProfile: vanity publicId selects the lead, not the viewer', () => {
  // The page redirects /in/ACwAA… → /in/candice-l-744a57101, so publicId is her slug.
  const t = pickTargetProfile(INCLUDED, 'candice-l-744a57101');
  assert.equal(t.firstName, 'Candice');
  assert.equal(t.publicIdentifier, 'candice-l-744a57101');
});

test('pickTargetProfile: vanity match is case-insensitive', () => {
  const t = pickTargetProfile(INCLUDED, 'Candice-L-744A57101');
  assert.equal(t.firstName, 'Candice');
});

test('pickTargetProfile: encoded /in/AC?AA token selects by member-token body prefix', () => {
  // Stayed on the encoded URL: lead token ACwAABn2UGQB1Poa… shares the body
  // prefix "Bn2UGQB" with Candice's URN ACoAABn2UGQBIQYP… (≥6) but NOT Pravin's.
  const t = pickTargetProfile(INCLUDED, 'ACwAABn2UGQB1Poa5gfvrTEa1l0GbCmX5KTyBbA');
  assert.equal(t.firstName, 'Candice');
});

test('pickTargetProfile: no entity matches the publicId → null (caller falls back)', () => {
  assert.equal(pickTargetProfile(INCLUDED, 'someone-else-999'), null);
});

test('pickTargetProfile: encoded token with no body-prefix match → null', () => {
  assert.equal(pickTargetProfile(INCLUDED, 'ACwAAZZZZ9999noprefixmatchatall'), null);
});

test('pickTargetProfile: empty / nullish inputs → null', () => {
  assert.equal(pickTargetProfile([], 'candice-l-744a57101'), null);
  assert.equal(pickTargetProfile(null, 'x'), null);
  assert.equal(pickTargetProfile(INCLUDED, ''), null);
});

test('pickTargetProfile: ignores non-profile entities in included', () => {
  const mixed = [
    { entityUrn: 'urn:li:fsd_company:123', name: 'Acme', publicIdentifier: 'candice-l-744a57101' },
    ...INCLUDED,
  ];
  const t = pickTargetProfile(mixed, 'candice-l-744a57101');
  assert.equal(t.firstName, 'Candice'); // company with same pub ignored, profile chosen
});
