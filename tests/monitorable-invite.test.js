import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countsAsMonitorableInvite } from '../src/campaign.js';

// The monitoring transition only fires when ≥1 profile had a monitorable
// pending invite this run. A NEW invite (connection_sent) obviously counts —
// but a lead ALREADY invited in a prior campaign returns already_processed
// (stamped "Connect Pending"), and that is still an outstanding invite to
// watch for acceptance + auto-DM/intro. Without counting it, a CC+DM/CC+IC
// re-run on already-pending leads sent "0 new" → no monitoring (the bug
// Antonio hit: 4 already-processed leads → counter stayed 0 → nothing to
// keep-monitoring).

test('connection_sent counts in any connect-then-followup mode', () => {
  assert.equal(countsAsMonitorableInvite('connection_sent', 'connect_and_message'), true);
  assert.equal(countsAsMonitorableInvite('connection_sent', 'connect_and_introduce'), true);
});

test('already_processed counts in CC+DM and CC+IC (pre-existing pending invite)', () => {
  assert.equal(countsAsMonitorableInvite('already_processed', 'connect_and_message'), true);
  assert.equal(countsAsMonitorableInvite('already_processed', 'connect_and_introduce'), true);
});

test('already_processed does NOT count in non-monitoring modes', () => {
  // connect_only never enters the monitoring phase; message_only/introduce_back
  // already_processed means "already DM'd/introduced", not a pending invite.
  assert.equal(countsAsMonitorableInvite('already_processed', 'connect_only'), false);
  assert.equal(countsAsMonitorableInvite('already_processed', 'message_only'), false);
  assert.equal(countsAsMonitorableInvite('already_processed', 'introduce_back'), false);
});

test('already_connected does NOT count (no pending invite to watch)', () => {
  assert.equal(countsAsMonitorableInvite('already_connected', 'connect_and_message'), false);
});

test('skips / unknown actions do not count', () => {
  assert.equal(countsAsMonitorableInvite('skipped', 'connect_and_message'), false);
  assert.equal(countsAsMonitorableInvite('status_pending', 'connect_and_message'), false);
  assert.equal(countsAsMonitorableInvite(undefined, 'connect_and_message'), false);
});
