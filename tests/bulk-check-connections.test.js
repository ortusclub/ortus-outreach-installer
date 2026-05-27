import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';

const baseRow = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  ...overrides,
});

const baseConns = [
  { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAaaa', memberNumber: '111' },
];

const stillPendingLabel = 'Still Pending (2026-05-12 10:00)';
const linkedinColumn = 'LinkedIn URL';

test('suppressAcceptedStamp=false: matched URL gets cc + connectedAlready in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 1);
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match, 'matched URL should be in updates');
  assert.equal(match.cc, 'Connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('suppressAcceptedStamp=true: matched URL returned in connectedUrls but NOT in updates', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls preserved');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'matched URL stamp suppressed from updates');
});

test('suppressAcceptedStamp=true: still-pending rows STILL get stamped', () => {
  const pendingRow = baseRow({
    'First Name': 'Bob',
    'Last Name': 'Smith',
    'LinkedIn URL': 'https://linkedin.com/in/bob-smith',
  });
  const { updates } = computeBulkCheckUpdates(
    [pendingRow], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: true }
  );
  const pendingStamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/bob-smith');
  assert.ok(pendingStamp, 'still-pending row should be stamped regardless of flag');
  assert.equal(pendingStamp.cc, stillPendingLabel);
});

test('back-compat: row with CC=Connected (new header) AND introduction made is skipped', () => {
  // v2.14.x: CC=Connected alone is NOT enough to skip — the intro might
  // have been interrupted (Stop pressed, browser died) leaving a Skipped
  // stamp that needs re-pickup. The authoritative "intro done" signal is
  // introductionStatus='Introduction Made'. See bulk-check-connections.js
  // re-ordering for SB-2.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'rows with intro already made are skipped');
});

test('SB-2 fix: row with CC=Connected but BLANK introductionStatus is re-pushed for intro retry', () => {
  // Repro of the SB-2 bug: a lead whose intro was interrupted mid-batch
  // had CC=Connected but no introductionStatus. Previous filter skipped
  // them forever; new filter re-pushes them to connectedUrls so the next
  // auto-intro pass fires.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Connected Status': '',
    // No Introduction Status — intro never fired or got interrupted.
  })];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'CC=Connected without intro IS re-pushed for retry');
  // CC is already at its target value — don't redundantly re-stamp it.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp when already Connected');
});

test('SB-2 fix: row with CC=Connected + Skipped — Stop pressed is re-pushed for intro retry', () => {
  // Specifically tests the new 'Skipped — Stop pressed' / 'Skipped — browser
  // closed' status from auto-intro.js's graceful-abort path. These statuses
  // must be treated identically to 'no intro status' — re-push for retry,
  // do not re-stamp CC.
  const rows = [baseRow({
    'Connection Accepted Status': 'Connected',
    'Introduction Status': 'Skipped — Stop pressed',
  })];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'Skipped status is treated as not-yet-introduced');
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(stamp, undefined, 'no CC re-stamp');
});

test('empty conns: pending rows still get Still Pending stamp; matched-set lookups yield no false matches', () => {
  const rows = [baseRow()];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, [], linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'no connections → no matches');
  // Row's request status IS "Connection Request Sent" → gets stamped Still Pending.
  const stamp = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(stamp, 'row should be stamped Still Pending');
  assert.equal(stamp.cc, stillPendingLabel);
});

test('empty rows: returns empty updates, empty connectedUrls, zero counters', () => {
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0);
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 0);
  assert.equal(diag.withUrl, 0);
});

test('row with missing LinkedIn URL: silently skipped, doesn\'t throw', () => {
  const rowWithoutUrl = { 'First Name': 'No', 'Last Name': 'URL' };
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [rowWithoutUrl], baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(updates.length, 0, 'no URL → no stamp');
  assert.equal(connectedUrls.length, 0);
  assert.equal(diag.rowsScanned, 1, 'still counted as scanned');
  assert.equal(diag.withUrl, 0, 'but withUrl=0 since URL was missing');
});

// v2.14.x — pre-existing 1st-degree connection branching
test('matched + wasInvited: stamps Connected (normal acceptance flow)', () => {
  const rows = [baseRow({ 'Connection Request Status': 'Connection Request Sent' })];
  const { updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.cc, 'Connected');
  assert.equal(match.checkStatus, 'Connected');
  assert.equal(match.stage, undefined, 'wasInvited path does NOT stamp stage');
  assert.equal(match.sender, undefined, 'wasInvited path does NOT stamp sender');
});

test('matched + NOT invited: stamps Sender + Stage = "Already connected" (pre-existing 1st-degree)', () => {
  // Row has no prior outreach by the bot — it's a lead the operator
  // already had as a 1st-degree connection. Bulk-check should stamp the
  // account that's connected so the operator sees WHO, and pre-filter
  // can skip the row from new connect sends.
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'still pushed to connectedUrls so runAutoIntros fires');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.ok(match);
  assert.equal(match.sender, 'kenya5@ortus.solutions');
  assert.equal(match.stage, 'Already connected');
  assert.equal(match.cc, 'Already connected');
  assert.equal(match.checkStatus, 'Already connected');
  assert.equal(match.connectedAlready, 'Yes');
});

test('matched + NOT invited + suppressAcceptedStamp: no stamp but URL returned for IC DM', () => {
  const rows = [baseRow({ 'Connection Request Status': '' })];
  const { updates, connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: true, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 1, 'connectedUrls still populated');
  const match = updates.find((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe');
  assert.equal(match, undefined, 'no stamp when suppressAcceptedStamp is true');
});

test('row marked "Already connected" + introduction already made: skipped (no re-stamp)', () => {
  // v2.14.x: CC='Already connected' alone is NOT enough — the row could
  // need an intro retry if the introductionStatus is blank/Skipped/Failed.
  // Authoritative "skip me" signal is introductionStatus='Introduction Made'
  // (or 'Introduction Already Made').
  const rows = [baseRow({
    'Connection Accepted Status': 'Already connected',
    'Connected Status': '',
    'Introduction Status': 'Introduction Made',
  })];
  const { connectedUrls, updates } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel,
    { suppressAcceptedStamp: false, profileName: 'kenya5@ortus.solutions' }
  );
  assert.equal(connectedUrls.length, 0, 'intro-already-made rows not re-pushed');
  assert.equal(updates.length, 0, 'no re-stamp');
});

test('sticky downgrade: row with CC starting with "Unverified — manual review" is skipped before isMatch', () => {
  const downgradedRow = baseRow({
    'First Name': 'Jane',
    'Last Name': 'Doe',
    'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
    'Connection Request Status': 'Connection Request Sent',
    'Connection Accepted Status': 'Unverified — manual review (May 27th, 2026)',
  });
  const { updates, connectedUrls, diag } = computeBulkCheckUpdates(
    [downgradedRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT be queued for auto-intro'
  );
  assert.ok(
    !updates.some((u) => u.linkedinUrl === 'https://linkedin.com/in/jane-doe'),
    'downgraded row must NOT receive any stamp write this pass'
  );
  assert.equal(diag.alreadyUnverified, 1, 'diag counter should record the skip');
});

test('cap: URL with composeAttempts >= 3 is excluded from connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 3]]);
  const { connectedUrls, diag } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    !connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL with 3+ compose-textbox failures must not re-enter the intro queue'
  );
  assert.equal(diag.composeCapped, 1, 'diag counter should record the cap skip');
});

test('cap: URL with composeAttempts < 3 still flows through to connectedUrls', () => {
  const matchingRow = baseRow();
  const composeAttempts = new Map([['https://linkedin.com/in/jane-doe', 2]]);
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, { composeAttempts }
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'URL below the cap must still be queued for auto-intro retry'
  );
});

test('cap: no composeAttempts opt (undefined) defaults to allow', () => {
  const matchingRow = baseRow();
  const { connectedUrls } = computeBulkCheckUpdates(
    [matchingRow], baseConns, linkedinColumn, stillPendingLabel, {}
  );
  assert.ok(
    connectedUrls.includes('https://linkedin.com/in/jane-doe'),
    'omitted composeAttempts must not block any URL (back-compat)'
  );
});
