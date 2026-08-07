// tests/fg-master.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FG_MASTER_HEADER, masterKey, invitedIndexFromFgInvites,
  masterRowFromRecord, buildMasterRows, chunkRows,
} from '../src/connections/fg-master.js';

const rec = (contact, warmVia = ['ada@ortus.example'], extra = {}) =>
  ({ contact, warmVia, hasWarm: warmVia.length > 0, dnc: false, ...extra });

const ADA = {
  firstname: 'Ada', lastname: 'Lovelace', jobtitle: 'Head of Marketing',
  company: 'Analytical', city: 'London', state: null, country: 'United Kingdom',
  linkedinbio: 'https://www.linkedin.com/in/ada/', linkedin_membership_id: '12345',
};

test('FG_MASTER_HEADER is the agreed 11 columns in order', () => {
  assert.deepEqual(FG_MASTER_HEADER, [
    'First Name', 'Last Name', 'Job Title', 'Company', 'Geo',
    'LinkedIn URL', 'Member ID', 'Connected Accounts',
    'Invited', 'Invited At', 'Invited By',
  ]);
});

test('masterKey prefers Member ID and falls back to the normalised URL', () => {
  assert.equal(masterKey({ memberId: '12345', url: 'https://linkedin.com/in/ada' }), '12345');
  assert.equal(masterKey({ memberId: '', url: 'https://www.linkedin.com/in/Ada/' }), 'linkedin.com/in/ada');
  assert.equal(masterKey({ memberId: '', url: '' }), '');
});

test('masterRowFromRecord fills geo, joins every connected account, and stringifies', () => {
  const row = masterRowFromRecord(rec(ADA, ['ada@ortus.example', 'bo@ortus.example']));
  assert.deepEqual(row, [
    'Ada', 'Lovelace', 'Head of Marketing', 'Analytical', 'London, United Kingdom',
    'https://www.linkedin.com/in/ada/', '12345', 'ada@ortus.example, bo@ortus.example',
    '', '', '',
  ]);
  for (const cell of row) assert.equal(typeof cell, 'string');
});

test('masterRowFromRecord returns null when the contact has no LinkedIn URL', () => {
  assert.equal(masterRowFromRecord(rec({ ...ADA, linkedinbio: '' })), null);
});

test('invitedIndexFromFgInvites indexes only Invited rows, by member id then url', () => {
  const idx = invitedIndexFromFgInvites([
    { 'Member ID': '12345', 'LinkedIn URL': 'https://linkedin.com/in/ada', Status: 'Invited', 'Invited At': '2026-07-01 09:00 UTC', Account: 'ada@ortus.example' },
    { 'Member ID': '', 'LinkedIn URL': 'https://www.linkedin.com/in/Bo/', Status: 'Invited', 'Invited At': '2026-07-02 09:00 UTC', Account: 'bo@ortus.example' },
    { 'Member ID': '999', 'LinkedIn URL': 'https://linkedin.com/in/cy', Status: 'Failed', 'Invited At': '', Account: 'cy@ortus.example' },
  ]);
  assert.deepEqual(idx.get('12345'), { invitedAt: '2026-07-01 09:00 UTC', invitedBy: 'ada@ortus.example' });
  assert.deepEqual(idx.get('linkedin.com/in/ada'), { invitedAt: '2026-07-01 09:00 UTC', invitedBy: 'ada@ortus.example' });
  assert.deepEqual(idx.get('linkedin.com/in/bo'), { invitedAt: '2026-07-02 09:00 UTC', invitedBy: 'bo@ortus.example' });
  assert.equal(idx.has('999'), false, 'Failed rows must not count as invited');
  assert.equal(idx.has('linkedin.com/in/cy'), false, 'Failed rows must not count as invited');
});

test('masterRowFromRecord stamps the ledger columns from the invited index', () => {
  const idx = invitedIndexFromFgInvites([
    { 'Member ID': '12345', 'LinkedIn URL': '', Status: 'Invited', 'Invited At': '2026-07-01 09:00 UTC', Account: 'ada@ortus.example' },
  ]);
  const row = masterRowFromRecord(rec(ADA), idx);
  assert.deepEqual(row.slice(8), ['Invited', '2026-07-01 09:00 UTC', 'ada@ortus.example']);
});

test('masterRowFromRecord falls back to the URL key when the DB has a Member ID but the invite row does not', () => {
  // DB record has a Member ID; the FG Invites row for the same person has a
  // blank Member ID and only the URL, so it's indexed under the URL key only.
  const idx = invitedIndexFromFgInvites([
    { 'Member ID': '', 'LinkedIn URL': 'https://www.linkedin.com/in/ada/', Status: 'Invited', 'Invited At': '2026-07-01 09:00 UTC', Account: 'ada@ortus.example' },
  ]);
  const row = masterRowFromRecord(rec(ADA), idx); // ADA.linkedin_membership_id = '12345'
  assert.deepEqual(row.slice(8), ['Invited', '2026-07-01 09:00 UTC', 'ada@ortus.example']);
});

test('buildMasterRows drops DNC, no-warm and URL-less records and counts them', () => {
  const out = buildMasterRows([
    rec(ADA),
    rec({ ...ADA, linkedinbio: 'https://linkedin.com/in/bo' }, [], { hasWarm: false }),
    rec({ ...ADA, linkedinbio: 'https://linkedin.com/in/cy' }, ['ada@ortus.example'], { dnc: true }),
    rec({ ...ADA, linkedinbio: '' }),
  ]);
  assert.equal(out.count, 1);
  assert.equal(out.rows.length, 1);
  assert.equal(out.droppedNoUrl, 1);
  assert.equal(out.rows[0][0], 'Ada');
});

test('chunkRows splits into fixed-size chunks with a short tail', () => {
  const rows = Array.from({ length: 7 }, (_, i) => [String(i)]);
  const chunks = chunkRows(rows, 3);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], [['0'], ['1'], ['2']]);
  assert.deepEqual(chunks[2], [['6']]);
  assert.deepEqual(chunkRows([], 3), []);
});
