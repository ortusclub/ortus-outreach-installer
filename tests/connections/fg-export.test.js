import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FG_HEADER, fgRow, functionMatch, inviteKey, normMonth } from '../../src/connections/fg-export.js';

const MARKETER_KEYWORDS = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];

test('FG_HEADER is the agreed 13-column order', () => {
  assert.deepEqual(FG_HEADER, [
    'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
    'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
    'Invited At', 'FG Note', 'Month',
  ]);
});

test('functionMatch returns the first matching keyword, case-insensitive', () => {
  assert.equal(functionMatch('Head of Brand Marketing', MARKETER_KEYWORDS), 'marketing');
  assert.equal(functionMatch('Chief Marketing Officer', MARKETER_KEYWORDS), 'marketing');
  assert.equal(functionMatch('Software Engineer', MARKETER_KEYWORDS), '');
  assert.equal(functionMatch('', MARKETER_KEYWORDS), '');
});

test('inviteKey prefers Member ID, falls back to URL', () => {
  assert.equal(inviteKey({ linkedin_membership_id: '4185', linkedinbio: 'https://x/in/a' }), '4185');
  assert.equal(inviteKey({ linkedin_membership_id: '', linkedinbio: 'https://x/in/a' }), 'https://x/in/a');
  assert.equal(inviteKey({}), '');
});

test('normMonth passes through a plain YYYY-MM and blanks empties', () => {
  assert.equal(normMonth('2026-06'), '2026-06');
  assert.equal(normMonth(''), '');
  assert.equal(normMonth(null), '');
  assert.equal(normMonth(undefined), '');
});

test('normMonth recovers the intended month from a tz-shifted ISO date', () => {
  // What the FG sheet currently serializes for a "June 2026" budget row: midnight
  // on June 1 in a +2 tz reads back as the last day of May at 22:00Z.
  assert.equal(normMonth('2026-05-31T22:00:00.000Z'), '2026-06');
  assert.equal(normMonth('2026-06-15'), '2026-06');
  assert.equal(normMonth('2025-12-31T23:00:00.000Z'), '2026-01');
});

test('normMonth leaves an unparseable string untouched', () => {
  assert.equal(normMonth('not a date'), 'not a date');
});

test('fgRow builds a rectangular all-string row in FG_HEADER order', () => {
  const record = { contact: {
    firstname: 'Alice', lastname: 'Ng', linkedinbio: 'https://x/in/alice',
    linkedin_membership_id: '41857001', company: 'Acme', jobtitle: 'Head of Growth',
    city: 'London', state: '', country: 'United Kingdom',
  } };
  const row = fgRow(record, {}, { operatorName: 'Sam', account: 'sam@li', month: '2026-06', keywords: MARKETER_KEYWORDS });
  assert.equal(row.length, FG_HEADER.length);
  assert.ok(row.every((c) => typeof c === 'string'));
  assert.equal(row[0], 'Alice Ng');
  assert.equal(row[2], '41857001');
  assert.equal(row[5], 'growth');
  assert.equal(row[6], 'London, United Kingdom');
  assert.equal(row[7], 'Sam');
  assert.equal(row[8], 'sam@li');
  assert.equal(row[9], 'Queued');
  assert.equal(row[10], '');
  assert.equal(row[12], '2026-06');
});
