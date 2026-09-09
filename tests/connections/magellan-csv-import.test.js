/**
 * Mapping a LinkedHelper export onto Magellan's connection rows — the core of
 * the "Import from CSV" feature for accounts not in GoLogin. The member id is
 * the whole point: it is the one field the raw LinkedIn export lacks and the
 * one Magellan keys every contact on.
 */
import test from 'node:test';
import assert from 'node:assert';
import {
  mapLinkedHelperRows, stageLinkedHelperCsv, splitDelimited, detectDelimiter,
} from '../../src/connections/magellan-csv-import.js';

// A minimal LinkedHelper export: only the columns the mapper reads, tab-separated.
const TSV_HEADER = ['public_id', 'member_id', 'hash_id', 'profile_url', 'email',
  'full_name', 'first_name', 'last_name', 'current_company', 'current_company_position',
  'location_name', 'cs_company_name', 'cs_job_title'].join('\t');

const tsvRow = (o) => [o.public_id || '', o.member_id || '', o.hash_id || '', o.profile_url || '',
  o.email || '', o.full_name || '', o.first_name || '', o.last_name || '',
  o.current_company || '', o.current_company_position || '',
  o.location_name || '', o.cs_company_name || '', o.cs_job_title || ''].join('\t');

test('extracts the numeric member id (the field the raw export lacks)', () => {
  const text = [TSV_HEADER, tsvRow({ member_id: '185039825', first_name: 'Raymond', last_name: 'Wong', profile_url: 'https://www.linkedin.com/in/raymond-wong-295b7751/' })].join('\n');
  const { rows, hadMemberIdColumn } = mapLinkedHelperRows(text);
  assert.equal(hadMemberIdColumn, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].memberId, '185039825');
  assert.equal(rows[0].url, 'https://www.linkedin.com/in/raymond-wong-295b7751/');
});

test('prefers the cleaned cs_ columns over raw current_company (which can be garbage)', () => {
  // cagdasatici's real case: current_company was "global scale" (parsed from the
  // headline), cs_company_name was "Booking.com".
  const text = [TSV_HEADER, tsvRow({
    member_id: '46485265', first_name: 'Cagdas', last_name: 'Atici',
    current_company: 'global scale', current_company_position: 'Director of Product',
    cs_company_name: 'Booking.com', cs_job_title: 'Director of Product Management',
  })].join('\n');
  const { rows } = mapLinkedHelperRows(text);
  assert.equal(rows[0].company, 'Booking.com');
  assert.equal(rows[0].position, 'Director of Product Management');
});

test('falls back to raw current_company when cs_ is blank', () => {
  const text = [TSV_HEADER, tsvRow({ member_id: '5', current_company: 'Acme', current_company_position: 'CEO' })].join('\n');
  const { rows } = mapLinkedHelperRows(text);
  assert.equal(rows[0].company, 'Acme');
  assert.equal(rows[0].position, 'CEO');
});

test('splits full_name only when first/last are blank', () => {
  const text = [TSV_HEADER, tsvRow({ member_id: '7', full_name: 'Ada Lovelace' })].join('\n');
  const { rows } = mapLinkedHelperRows(text);
  assert.equal(rows[0].firstName, 'Ada');
  assert.equal(rows[0].lastName, 'Lovelace');
});

test('rows with no member id are skipped and counted, not imported', () => {
  const text = [TSV_HEADER,
    tsvRow({ member_id: '111', first_name: 'Has' }),
    tsvRow({ member_id: '', first_name: 'Missing' }),
    tsvRow({ member_id: 'not-a-number', first_name: 'Bad' }),
  ].join('\n');
  const { rows, total, skippedNoMemberId } = mapLinkedHelperRows(text);
  assert.equal(total, 3);
  assert.equal(rows.length, 1);
  assert.equal(skippedNoMemberId, 2);
});

test('a raw LinkedIn export (no member_id column) is detected, not silently emptied', () => {
  const raw = ['First Name,Last Name,URL,Email Address,Company,Position,Connected On',
    'Peaches,Lazatin,https://www.linkedin.com/in/peaches-lazatin-a60750313,,SMS,HR,04 Sep 2026'].join('\n');
  const { hadMemberIdColumn, rows } = mapLinkedHelperRows(raw);
  assert.equal(hadMemberIdColumn, false);
  assert.equal(rows.length, 0);
});

test('parses the comma-separated (CSV) export too, with quoted fields', () => {
  const header = 'member_id,profile_url,first_name,last_name,cs_company_name,cs_job_title';
  const row = '999,https://www.linkedin.com/in/x,Jane,Doe,"Doe, Inc.",Head of Sales';
  const { rows } = mapLinkedHelperRows([header, row].join('\n'));
  assert.equal(rows[0].memberId, '999');
  assert.equal(rows[0].company, 'Doe, Inc.'); // comma inside quotes preserved
});

test('splitDelimited handles escaped quotes; detectDelimiter picks tab over comma', () => {
  assert.deepEqual(splitDelimited('a,"b,c","d""e"', ','), ['a', 'b,c', 'd"e']);
  assert.equal(detectDelimiter('x\ty\tz'), '\t');
  assert.equal(detectDelimiter('x,y,z'), ',');
});

// ── stageLinkedHelperCsv ──────────────────────────────────────────────────

test('stage: rejects a missing/blank owner email', () => {
  assert.throws(() => stageLinkedHelperCsv('', TSV_HEADER, { write: () => {} }), /valid owner email/);
  assert.throws(() => stageLinkedHelperCsv('notanemail', TSV_HEADER, { write: () => {} }), /valid owner email/);
});

test('stage: rejects a raw LinkedIn export with a clear LinkedHelper message', () => {
  const raw = 'First Name,Last Name,URL\nA,B,http://x';
  assert.throws(() => stageLinkedHelperCsv('kenji@ortusclub.com', raw, { write: () => {} }),
    /LinkedHelper first/);
});

test('stage: lower-cases the owner email and writes the mapped rows', () => {
  let wroteAccount; let wroteRows;
  const write = (account, rows) => { wroteAccount = account; wroteRows = rows; return `/x/${account}.csv`; };
  const text = [TSV_HEADER, tsvRow({ member_id: '185039825', first_name: 'Raymond', last_name: 'Wong' })].join('\n');
  const out = stageLinkedHelperCsv('Kenji@OrtusClub.com', text, { write });
  assert.equal(wroteAccount, 'kenji@ortusclub.com');
  assert.equal(out.account, 'kenji@ortusclub.com');
  assert.equal(out.staged, 1);
  assert.equal(wroteRows[0].memberId, '185039825');
});

test('stage: refuses when every row lacks a member id', () => {
  const text = [TSV_HEADER, tsvRow({ member_id: '' })].join('\n');
  assert.throws(() => stageLinkedHelperCsv('kenji@ortusclub.com', text, { write: () => {} }),
    /none had a LinkedIn member id/);
});
