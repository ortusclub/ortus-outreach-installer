/**
 * CC+IC duplicate-profile safety check (spec: boss report 2026-06-16).
 *
 * Two identical rows written one under the other (e.g. rows 109 & 110) both
 * pass the per-row "Introduction Status is blank" guard, so the same person
 * gets pushed into connectedUrls twice and is introduced multiple times. The
 * sheet-state guard can't help — both rows are blank. The fix dedups the intro
 * work-list by STRONG IDENTITY (slug + ACwAA token + numeric Membership ID),
 * collapsing same-person rows to ONE intro, and skips a blank duplicate whose
 * twin has already been introduced (durable across app restarts).
 *
 * These tests target the pure helper computeBulkCheckUpdates — the point where
 * connectedUrls is built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBulkCheckUpdates } from '../src/linkedin/bulk-check-connections.js';
import { _dedupeIntroUrls } from '../src/linkedin/auto-intro.js';

const stillPendingLabel = 'Still Pending (2026-06-16 10:00)';
const linkedinColumn = 'LinkedIn URL';

const row = (overrides = {}) => ({
  'First Name': 'Jane',
  'Last Name': 'Doe',
  'LinkedIn URL': 'https://linkedin.com/in/jane-doe',
  'Connection Request Status': 'Connection Request Sent',
  'Connected Status': '',
  'Introduction Status': '',
  ...overrides,
});

const conns = (overrides = {}) => ([{
  firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe',
  urn: 'ACoAAjane', memberNumber: '111', account: '',
  ...overrides,
}]);

const startsWithSkippedDuplicate = (u) =>
  /^skipped\s+—\s+duplicate/i.test((u.introductionStatus || '').toString());

test('identical duplicate rows in one sweep collapse to a SINGLE intro', () => {
  const rows = [row(), row()]; // 109 & 110 — byte-identical
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, conns(), linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 1, 'same person must be queued for intro exactly once');
  assert.equal(connectedUrls[0], 'https://linkedin.com/in/jane-doe');
});

test('the collapsed duplicate is visibly flagged (Skipped — duplicate) + counted in diag', () => {
  const rows = [row(), row()];
  const { updates, diag } = computeBulkCheckUpdates(
    rows, conns(), linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(diag.duplicateCollapsed, 1, 'diag should report one collapsed duplicate');
  assert.ok(
    updates.some(startsWithSkippedDuplicate),
    'the duplicate row should be stamped "Skipped — duplicate …" so the operator can see the safeguard fired'
  );
});

test('durable: a blank duplicate of an already-introduced row is NOT re-queued (same URL)', () => {
  const rows = [
    row({ 'Introduction Status': 'Introduction Made' }), // 109 — done
    row(), // 110 — blank duplicate, would re-fire after a restart
  ];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, conns(), linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'already-introduced person must not be re-introduced via a blank twin');
});

test('durable strong-identity: blank duplicate in a different URL form is NOT re-queued', () => {
  const rows = [
    row({ 'Introduction Status': 'Introduction Made' }),                 // /in/jane-doe — done
    row({ 'LinkedIn URL': 'https://linkedin.com/in/jane-doe?trk=foo' }), // same slug, query param, blank
  ];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, conns(), linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'same person via a different URL form must be recognised as a duplicate');
});

test('durable strong-identity: numeric Membership ID links a member-id URL to the introduced row', () => {
  const rows = [
    row({ 'Introduction Status': 'Introduction Made', 'LinkedIn Membership ID': '111' }), // done
    row({ 'LinkedIn URL': 'https://linkedin.com/in/acwaajane', 'LinkedIn Membership ID': '111' }), // blank, member-id URL
  ];
  const { connectedUrls } = computeBulkCheckUpdates(
    rows, conns(), linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 0, 'numeric Membership ID must collapse the member-id-URL duplicate');
});

// ── Defense in depth: the auto-intro work-list consumer dedups too, so even a
// caller that hands runAutoIntros a list with the same person twice can never
// double-fire within one pass.
test('work-list dedup: exact-duplicate URLs collapse to one', () => {
  const u = 'https://linkedin.com/in/jane-doe';
  const { urls, duplicates } = _dedupeIntroUrls([u, u], new Map());
  assert.deepEqual(urls, [u]);
  assert.equal(duplicates, 1);
});

test('work-list dedup: different URL forms of the same person collapse to one', () => {
  const a = 'https://linkedin.com/in/jane-doe';
  const b = 'https://linkedin.com/in/jane-doe?trk=foo';
  const { urls } = _dedupeIntroUrls([a, b], new Map([[a, {}], [b, {}]]));
  assert.equal(urls.length, 1);
});

test('work-list dedup: distinct people are preserved', () => {
  const { urls, duplicates } = _dedupeIntroUrls(
    ['https://linkedin.com/in/jane-doe', 'https://linkedin.com/in/john-smith'], new Map()
  );
  assert.equal(urls.length, 2);
  assert.equal(duplicates, 0);
});

test('regression: two DISTINCT people both queue (dedup must not over-collapse)', () => {
  const rows = [
    row(),
    row({ 'First Name': 'John', 'Last Name': 'Smith', 'LinkedIn URL': 'https://linkedin.com/in/john-smith' }),
  ];
  const matchConns = [
    { firstName: 'Jane', lastName: 'Doe', publicId: 'jane-doe', urn: 'ACoAAjane', memberNumber: '111', account: '' },
    { firstName: 'John', lastName: 'Smith', publicId: 'john-smith', urn: 'ACoAAjohn', memberNumber: '222', account: '' },
  ];
  const { connectedUrls, diag } = computeBulkCheckUpdates(
    rows, matchConns, linkedinColumn, stillPendingLabel, { suppressAcceptedStamp: false }
  );
  assert.equal(connectedUrls.length, 2, 'two different people must both be queued');
  assert.equal(diag.duplicateCollapsed || 0, 0, 'no duplicates should be reported for distinct people');
});
