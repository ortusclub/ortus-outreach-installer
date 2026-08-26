import test from 'node:test';
import assert from 'node:assert/strict';
import { isIdentityRestrictedStatus, identityRestrictionLabel } from '../src/soo-restrictions.js';

test('SoO identity restrictions are recognized without broadening normal states', () => {
  assert.equal(isIdentityRestrictedStatus('Identity Restricted'), true);
  assert.equal(isIdentityRestrictedStatus('Temporarily Restricted'), true);
  assert.equal(isIdentityRestrictedStatus('Active'), false);
  assert.equal(identityRestrictionLabel({ Status: 'Identity Restricted' }), 'Identity Restricted');
  assert.equal(identityRestrictionLabel({ Status: 'Active' }), '');
});
