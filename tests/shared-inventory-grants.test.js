/**
 * The shared inventory: Ortus-owned accounts the SoO parks under
 * "INVENTORY: DO NOT USE" with NA credits so Ortus operators leave them alone,
 * because Linked Velocity is the team meant to drive them.
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  canOperatorUseProfile, usesProfileAsGuest, grantsForProfile,
  SHARED_INVENTORY_GRANTS,
} from '../src/gologin-accounts.js';

const MILEE_MEL = '686696205c3c6094e10f461c'; // milee.mel@ortus.solutions
const UNGRANTED = '69ea1e80447186275e79e3ee'; // an ordinary Ortus account

test('Linked Velocity drives the granted inventory', () => {
  for (const id of Object.keys(SHARED_INVENTORY_GRANTS)) {
    assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', id), true, id);
  }
});

test('the grant does not open the rest of the Ortus roster', () => {
  assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus', UNGRANTED), false);
  assert.equal(canOperatorUseProfile('milee@linkedvelocity.com', 'ortus'), false); // no id, no grant
});

test('a granted profile is flagged as driven by a guest', () => {
  // Milee reaches it through the grant, so the Ortus SoO does not govern it.
  assert.equal(usesProfileAsGuest('milee@linkedvelocity.com', 'ortus', MILEE_MEL), true);
  // An Ortus operator owns the workspace outright, so it still does.
  assert.equal(usesProfileAsGuest('antoniov@ortusclub.com', 'ortus', MILEE_MEL), false);
});

test('the committed list and a local .env grant coexist', () => {
  const before = process.env.GOLOGIN_PROFILE_GRANTS;
  process.env.GOLOGIN_PROFILE_GRANTS = `linkedvelocity:${UNGRANTED}`;
  try {
    assert.deepEqual(grantsForProfile(MILEE_MEL), ['linkedvelocity']); // committed
    assert.deepEqual(grantsForProfile(UNGRANTED), ['linkedvelocity']); // env
  } finally {
    if (before === undefined) delete process.env.GOLOGIN_PROFILE_GRANTS;
    else process.env.GOLOGIN_PROFILE_GRANTS = before;
  }
});
