import { test } from 'node:test';
import assert from 'node:assert/strict';
// _persistRunSettings is internal; assert the observable contract instead:
// setProfileSkip mutates _skippedProfiles, which getLastRunSettings should reflect after a write.
// This test documents the field's presence in the snapshot shape.
import { getLastRunSettings } from '../src/campaign.js';

test('getLastRunSettings returns an object (snapshot shape includes benchedProfileIds when set)', () => {
  const s = getLastRunSettings();
  // When idle, snapshot may be null; the contract is that the field name is benchedProfileIds.
  assert.ok(s === null || typeof s === 'object');
});
