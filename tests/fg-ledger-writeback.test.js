// ledgerUpdatesFromLeads speaks FG's own vocabulary ({url,status,invitedAt,
// note,memberId}); the main Apps Script's updateRow speaks FIELD_MAP keys.
// This is the translation between them. It has to be exact — writeFields drops
// unknown keys without complaining, so a typo here writes nothing at all and
// reports success.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fgLedgerTracking, ledgerUpdatesFromLeads } from '../src/connections/fg-list.js';

test('an invited lead translates to all four FIELD_MAP keys', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/ada', stage: 'Invited', sentAt: '2026-08-10T09:00:00.000Z' },
  ]);
  const t = fgLedgerTracking(u);
  assert.equal(t.fgStatus, 'Invited');
  assert.ok(t.fgInvitedAt, 'an invited row must carry a timestamp');
  assert.equal(typeof t.fgNote, 'string');
  assert.equal(typeof t.fgMemberId, 'string');
});

test('a skipped lead carries its reason into the Note column', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/bob', status: 'skipped', error: 'already follows' },
  ]);
  const t = fgLedgerTracking(u);
  assert.equal(t.fgStatus, 'Skipped');
  assert.equal(t.fgNote, 'already follows');
});

test('a failed lead is Failed, not silently Skipped', () => {
  const [u] = ledgerUpdatesFromLeads([
    { leadUrl: 'https://www.linkedin.com/in/cy', status: 'error', error: 'profile not found' },
  ]);
  assert.equal(fgLedgerTracking(u).fgStatus, 'Failed');
});

test('missing optional fields become empty strings, never undefined', () => {
  // undefined would be dropped from the JSON POST body entirely, leaving a
  // stale value in the cell from a previous run.
  const t = fgLedgerTracking({ url: 'https://www.linkedin.com/in/dee', status: 'Skipped' });
  assert.equal(t.fgInvitedAt, '');
  assert.equal(t.fgNote, '');
  assert.equal(t.fgMemberId, '');
});

test('the keys are exactly the four FG FIELD_MAP keys and nothing else', () => {
  const t = fgLedgerTracking({ url: 'https://www.linkedin.com/in/dee', status: 'Invited' });
  assert.deepEqual(Object.keys(t).sort(), ['fgInvitedAt', 'fgMemberId', 'fgNote', 'fgStatus']);
});
