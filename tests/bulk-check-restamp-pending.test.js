// A row already reading "Still Pending (<old time>)" must be RE-STAMPED with the
// current sweep's timestamp, so the cell answers "when was this last checked?".
//
// Before this, the v2.78 interim speedup skipped any already-pending row to keep
// the cell-by-cell Apps Script write small. That froze the timestamp at whenever
// the row FIRST went pending — operator report 2026-07-30: leads invited on
// 27 Jul still read "Still Pending (2026-07-27 16:45)" three days and dozens of
// sweeps later, which reads as "never checked". handleBatchUpdate (the batch
// write that comment named as the precondition) has since shipped.
//
// The two guards that must SURVIVE are pinned below: a Connected row is never
// downgraded, and a foreign sender never refreshes someone else's row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';

const linkedinColumn = 'LinkedIn URL';
const FRESH = 'Still Pending (2026-07-30 11:31)';
const STALE = 'Still Pending (2026-07-27 16:45)';

const row = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connection Accepted Status': '',
  'Introduction Status': '',
  Sender: 'acct-a',
  ...overrides,
});

// Nobody in the recent-connections tab → the lead is still pending.
const noConns = [];

test('an already-"Still Pending" row is re-stamped with the current timestamp', () => {
  const { updates } = computeBulkCheckUpdates(
    [row({ 'Connection Accepted Status': STALE })],
    noConns, linkedinColumn, FRESH, { profileName: 'acct-a' },
  );
  const u = updates.find((x) => x.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(u, 'the stale pending row must produce an update');
  assert.equal(u.cc, FRESH, 'timestamp refreshed to this sweep');
  assert.equal(u.checkStatus, FRESH);
});

test('a blank row still gets its first Still Pending stamp', () => {
  const { updates } = computeBulkCheckUpdates(
    [row()], noConns, linkedinColumn, FRESH, { profileName: 'acct-a' },
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].cc, FRESH);
});

test('REGRESSION: a Connected row is never downgraded to Still Pending', () => {
  // The ~80-connection recent window means older accepted invites fall off the
  // fetch. Re-stamping them would wipe the audit trail (screenshot 2026-05-16).
  for (const cs of ['Connected', 'Already connected']) {
    const { updates } = computeBulkCheckUpdates(
      [row({ 'Connection Accepted Status': cs })],
      noConns, linkedinColumn, FRESH, { profileName: 'acct-a' },
    );
    assert.equal(
      updates.filter((u) => /^still pending/i.test(String(u.cc || ''))).length, 0,
      `${cs} must not be downgraded`);
  }
});

test('REGRESSION: a foreign sender does not refresh another account\'s row', () => {
  // v2.62 sender-scoping: only the row's assigned Sender refreshes its pending
  // stamp. Removing the already-pending guard must not widen this.
  const { updates } = computeBulkCheckUpdates(
    [row({ 'Connection Accepted Status': STALE, Sender: 'acct-b' })],
    noConns, linkedinColumn, FRESH, { profileName: 'acct-a' },
  );
  assert.equal(updates.length, 0, 'acct-a must leave acct-b\'s row alone');
});

test('REGRESSION: a non-empty Introduction Status still blocks the re-stamp', () => {
  const { updates } = computeBulkCheckUpdates(
    [row({ 'Connection Accepted Status': STALE, 'Introduction Status': 'Introduction Made' })],
    noConns, linkedinColumn, FRESH, { profileName: 'acct-a' },
  );
  assert.equal(updates.length, 0);
});
