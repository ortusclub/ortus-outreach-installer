import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintLeads, vanitySlug, nameMatchesSlug } from '../src/preflight-lint.js';

const R = (rowNumber, row) => ({ rowNumber, row });
const BASE = { linkedinColumn: 'LinkedIn URL', mode: 'connect_only', templates: {}, blocklist: [], tabCount: 1, gidExplicit: true };

test('vanitySlug extracts vanity, rejects encoded', () => {
  assert.equal(vanitySlug('https://www.linkedin.com/in/leonkatsnelson/'), 'leonkatsnelson');
  assert.equal(vanitySlug('https://linkedin.com/in/jane-doe-123abc'), 'jane-doe-123abc');
  assert.equal(vanitySlug('https://www.linkedin.com/in/ACwAAB3xYz_encoded'), null);
  assert.equal(vanitySlug('https://www.linkedin.com/sales/people/ACwAAB3xYz,NAME'), null);
  assert.equal(vanitySlug('not a url'), null);
});

test('nameMatchesSlug: real incident cases', () => {
  // Row 413: Lavanya Vemula + leonkatsnelson → mismatch
  assert.equal(nameMatchesSlug('Lavanya', 'Vemula', 'leonkatsnelson'), false);
  // Mohammed (Sajid) Omer + msajidomer → "omer" token present → match
  assert.equal(nameMatchesSlug('Sajid', 'Omer', 'msajidomer'), true);
  // hyphenated slug
  assert.equal(nameMatchesSlug('Jane', 'Doe', 'jane-doe-1a2b3c'), true);
  // single-name overlap is enough
  assert.equal(nameMatchesSlug('Leon', 'Katsnelson', 'leonkatsnelson'), true);
  // diacritics normalize
  assert.equal(nameMatchesSlug('José', 'García', 'jose-garcia'), true);
  // missing names → cannot judge → treated as match (no false alarm)
  assert.equal(nameMatchesSlug('', '', 'leonkatsnelson'), true);
});

test('lintLeads flags name_url_mismatch as blocker with stamp text', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(413, { 'First Name': 'Lavanya', 'Last Name': 'Vemula', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 1);
  const f = out.blockers[0];
  assert.equal(f.check, 'name_url_mismatch');
  assert.equal(f.rowIndex, 413);
  assert.equal(f.leadName, 'Lavanya Vemula');
  assert.equal(f.stampText, 'Skipped: name≠URL');
});

test('encoded URLs are not name-checked', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(5, { 'First Name': 'Alice', 'Last Name': 'Wong', 'LinkedIn URL': 'https://www.linkedin.com/in/ACwAAB3xYzTest' }),
  ]});
  assert.equal(out.blockers.filter(f => f.check === 'name_url_mismatch').length, 0);
});

test('malformed_url blocker for junk in the URL cell', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(87, { 'First Name': 'Bob', 'Last Name': 'Ray', 'LinkedIn URL': 'htp:/linkedin,com/bob' }),
  ]});
  assert.equal(out.blockers.length, 1);
  assert.equal(out.blockers[0].check, 'malformed_url');
});

test('duplicate_url warning lists both rows', () => {
  const url = 'https://www.linkedin.com/in/vito-manzari/';
  const out = lintLeads({ ...BASE, rows: [
    R(109, { 'First Name': 'Vito', 'Last Name': 'Manzari', 'LinkedIn URL': url }),
    R(110, { 'First Name': 'Vito', 'Last Name': 'Manzari', 'LinkedIn URL': url }),
  ]});
  const dups = out.warnings.filter(f => f.check === 'duplicate_url');
  assert.equal(dups.length, 1);
  assert.match(dups[0].detail, /109/);
  assert.match(dups[0].detail, /110/);
});

test('clean rows produce no findings and count targets', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(2, { 'First Name': 'Leon', 'Last Name': 'Katsnelson', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 0);
  assert.equal(out.warnings.length, 0);
  assert.equal(out.targetCount, 1);
});

test('rows with terminal Stage are ignored entirely', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(3, { 'First Name': 'Lavanya', 'Last Name': 'Vemula', Stage: 'Done',
           'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.equal(out.blockers.length, 0);
  assert.equal(out.targetCount, 0);
});
