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

test('back-compat: recognizes "Connection Accepted Status" as already-Connected header', () => {
  const rows = [baseRow({ 'Connection Accepted Status': 'Connected', 'Connected Status': '' })];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, baseConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  // Row already shows Connected via the NEW header — should be skipped (no re-stamp).
  assert.equal(connectedUrls.length, 0, 'rows already marked Connected via new header are skipped');
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
