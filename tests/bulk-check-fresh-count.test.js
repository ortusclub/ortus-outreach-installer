// The sweep summary reports "N newly accepted" from connectedUrls.length — but
// connectedUrls does NOT mean "accepted this sweep". It means "1st-degree AND
// intro slot still open", which is the work-list for the auto-intro pass.
//
// So a lead stamped Connected weeks ago whose intro never landed ('Failed — …',
// 'Skipped — Stop pressed', a cleared cell) is re-queued — correctly, that is
// how an interrupted intro recovers — and re-counted as "newly accepted" on
// EVERY sweep, forever. Operator report 2026-07-30: a sweep logged
// "2 newly accepted, 0 lead row(s) updated"; the 0 was the honest number, since
// both rows were already stamped and nothing changed.
//
// computeBulkCheckUpdates therefore also returns freshConnected: the subset of
// connectedUrls whose Connection Accepted Status was NOT already Connected —
// i.e. the ones that genuinely accepted since the last sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';
import { INTRO_RETRY_RECONNECT } from '../src/linkedin/intro-constants.js';

const linkedinColumn = 'LinkedIn URL';
const STAMP = 'Still Pending (2026-07-31 11:06)';

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

// A recent-connections entry that matches `row()` on the slug axis. `publicId`
// is the slug key the matcher indexes on; `account` is the owning sender.
const conn = (slug = 'jane-doe') => ({ publicId: slug, account: 'acct-a' });

const opts = { profileName: 'acct-a' };

test('a genuine new acceptance counts as fresh', () => {
  const r = computeBulkCheckUpdates(
    [row()], [conn()], linkedinColumn, STAMP, opts,
  );
  assert.equal(r.connectedUrls.length, 1, 'queued for intro');
  assert.equal(r.freshConnected, 1, 'and it genuinely accepted this sweep');
});

test('an already-Connected lead re-queued for a retried intro is NOT fresh', () => {
  // The exact shape behind "2 newly accepted, 0 lead row(s) updated": already
  // stamped Connected, so no cell changes — but the intro slot is open (the
  // revive sentinel), so it is legitimately re-queued for the intro pass.
  const r = computeBulkCheckUpdates(
    [row({
      'Connection Accepted Status': 'Connected',
      'Introduction Status': INTRO_RETRY_RECONNECT,
    })],
    [conn()], linkedinColumn, STAMP, opts,
  );
  assert.equal(r.connectedUrls.length, 1, 'still queued — an interrupted intro must recover');
  assert.equal(r.freshConnected, 0, 'but it did NOT accept this sweep');
});

test('mixed sweep counts only the genuinely new one', () => {
  const r = computeBulkCheckUpdates(
    [
      row(),
      row({
        'First Name': 'Bob',
        'LinkedIn URL': 'https://linkedin.com/in/bob-smith',
        'Connection Accepted Status': 'Already connected',
        'Introduction Status': INTRO_RETRY_RECONNECT,
      }),
    ],
    [conn(), conn('bob-smith')], linkedinColumn, STAMP, opts,
  );
  assert.equal(r.connectedUrls.length, 2, 'both go to the intro pass');
  assert.equal(r.freshConnected, 1, 'only Jane accepted this sweep');
});

test('freshConnected never exceeds connectedUrls', () => {
  // Guards the reporting invariant the log line depends on: the headline number
  // is a subset of the work-list, so "N newly accepted, M re-queued" can never
  // read as a negative M.
  const r = computeBulkCheckUpdates(
    [row({ 'Connection Accepted Status': 'Connected', 'Introduction Status': INTRO_RETRY_RECONNECT })],
    [conn()], linkedinColumn, STAMP, opts,
  );
  assert.ok(r.freshConnected <= r.connectedUrls.length);
});
