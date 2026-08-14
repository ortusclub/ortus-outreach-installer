import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FG_HEADER, FG_BASE_COLUMNS, FG_RUN_COLUMNS, fgRow, functionMatch, inviteKey, normMonth } from '../../src/connections/fg-export.js';
import { stampRunCells } from '../../src/connections/fg-sync.js';

const MARKETER_KEYWORDS = ['marketing', 'brand', 'growth', 'content', 'demand', 'comms', 'cmo'];

test('FG_HEADER is the agreed 16-column order', () => {
  assert.deepEqual(FG_HEADER, [
    'Target Name', 'LinkedIn URL', 'Member ID', 'Company', 'Job Title',
    'Function Match', 'Geo', 'Invited By', 'Account', 'Status',
    'Invited At', 'FG Note', 'Month',
    'Run ID', 'Run At', 'Reason',
  ]);
});

// The deployed Apps Script writes with getRange(..., FG_HEADER.length) and its
// own copy of the header. A "KEEP IN SYNC" comment is what guarded this before,
// and the two drifted for four weeks: the three run columns were added here on
// 17 July and this test still asserted thirteen.
test('FG_HEADER matches the FG_HEADER in fg-apps-script.js', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fg-apps-script.js'), 'utf8');
  const block = /var FG_HEADER = \[([\s\S]*?)\]/.exec(src);
  assert.ok(block, 'fg-apps-script.js must declare var FG_HEADER = [...]');
  const script = [...block[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(script, FG_HEADER);
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

test('fgRow builds a rectangular all-string row in FG_BASE_COLUMNS order', () => {
  const record = { contact: {
    firstname: 'Alice', lastname: 'Ng', linkedinbio: 'https://x/in/alice',
    linkedin_membership_id: '41857001', company: 'Acme', jobtitle: 'Head of Growth',
    city: 'London', state: '', country: 'United Kingdom',
  } };
  const row = fgRow(record, {}, { operatorName: 'Sam', account: 'sam@li', month: '2026-06', keywords: MARKETER_KEYWORDS });
  // fgRow is the BASE half of a row. It is short of FG_HEADER by exactly the
  // run columns, which stampRunCells appends on the way to the sheet.
  assert.equal(row.length, FG_BASE_COLUMNS.length);
  assert.equal(FG_BASE_COLUMNS.length + FG_RUN_COLUMNS.length, FG_HEADER.length);
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

// The pair above is only safe because every write path goes through
// queueFgInvites → stampRunCells. These pin that seam: a base row in, a full
// FG_HEADER row out, and nothing ragged reaching setValues (Apps Script throws
// on a row whose width does not match the range).
test('stampRunCells completes a base row into a full FG_HEADER row', () => {
  const base = fgRow({ contact: { firstname: 'Alice', lastname: 'Ng' } }, {}, { account: 'sam@li', month: '2026-06' });
  const [out] = stampRunCells([base], { runId: 'run_7', runAt: '2026-08-14T10:00:00.000Z' });
  assert.equal(out.length, FG_HEADER.length);
  assert.ok(out.every((c) => typeof c === 'string'));
  assert.equal(out[FG_HEADER.indexOf('Run ID')], 'run_7');
  assert.equal(out[FG_HEADER.indexOf('Run At')], '2026-08-14T10:00:00.000Z');
  assert.equal(out[FG_HEADER.indexOf('Reason')], '');
  assert.deepEqual(out.slice(0, FG_BASE_COLUMNS.length), base);
});

test('stampRunCells pads a short row and trims an over-long one', () => {
  // Rows come back from a sheet read as well as from fgRow, and a trailing
  // empty cell is dropped on the way. Either way the write must be rectangular.
  const [short] = stampRunCells([['only', 'two']], {});
  assert.equal(short.length, FG_HEADER.length);
  assert.equal(short[FG_BASE_COLUMNS.length - 1], '');
  const [long] = stampRunCells([new Array(FG_HEADER.length + 4).fill('x')], { runId: 'r' });
  assert.equal(long.length, FG_HEADER.length);
  assert.equal(long[FG_HEADER.indexOf('Run ID')], 'r');
});
