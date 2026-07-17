// tests/fg-already-invited-status.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure helper extracted in Step 3.
import { invitedKeysFromState } from '../src/connections/fg-sync.js';

test('only Invited rows count as already-invited (Failed is retryable)', () => {
  const invites = [
    { 'Member ID': '111', 'Status': 'Invited' },
    { 'Member ID': '222', 'Status': 'Failed' },
    { 'Member ID': '',    'LinkedIn URL': 'https://x/z', 'Status': 'Queued' },
    { 'Member ID': '333', 'LinkedIn URL': 'https://x/y', 'Status': 'Invited' },
  ];
  assert.deepEqual(invitedKeysFromState(invites), ['111', '333']);
});
