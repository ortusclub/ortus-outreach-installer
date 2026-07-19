import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintLeads, vanitySlug, nameMatchesSlug, blocklistExcludedUrls, normalizeProfileUrl } from '../src/preflight-lint.js';

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

// ── Task 3 tests ─────────────────────────────────────────────────────────────
const IBM = { value: 'IBM', kind: 'company', reason: 'existing client', addedBy: '', addedAt: '' };
const ORTUS = { value: 'ortusclub.com', kind: 'domain', reason: 'employees', addedBy: '', addedAt: '' };

test('blocklist company match is a blocker with the exact stamp, word-boundary safe', () => {
  const out = lintLeads({ ...BASE, blocklist: [IBM], rows: [
    R(44, { 'First Name': 'Ann', 'Last Name': 'Lee', Company: 'IBM', 'LinkedIn URL': 'https://linkedin.com/in/ann-lee-ibm' }),
    R(45, { 'First Name': 'Zed', 'Last Name': 'Ka', Company: 'Ibmara Consulting', 'LinkedIn URL': 'https://linkedin.com/in/zed-ka' }),
  ]});
  const hits = out.blockers.filter(f => f.check === 'blocklist_match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rowIndex, 44);
  assert.equal(hits[0].stampText, 'Skipped: blocklist — IBM');
});

test('blocklist match survives header-case mismatch (VM leak regression 2026-07-10)', () => {
  // Config column is "LinkedIn URL"; the actual sheet header is lowercase
  // "linkedin url". The old exact-key read returned undefined → every row was
  // treated as empty and skipped → the blocklist never ran → a blocklisted
  // company (IBM) got a connection request on a cloud run. The linter must now
  // resolve the URL column case-insensitively, like the sender does.
  const out = lintLeads({ ...BASE, linkedinColumn: 'LinkedIn URL', blocklist: [IBM], rows: [
    R(4, { 'First Name': 'Angelica', 'Last Name': 'Agor', Company: 'IBM', 'linkedin url': 'https://www.linkedin.com/in/angelica-nathanielle-agor-b816531b1/' }),
  ]});
  const hits = out.blockers.filter(f => f.check === 'blocklist_match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].leadName, 'Angelica Agor');
  assert.equal(hits[0].stampText, 'Skipped: blocklist — IBM');
});

test('blocklist domain match on email column, suffix-safe', () => {
  const out = lintLeads({ ...BASE, blocklist: [ORTUS], rows: [
    R(7, { 'First Name': 'Dion', 'Last Name': 'X', Email: 'dion@mail.ortusclub.com', 'LinkedIn URL': 'https://linkedin.com/in/dion-x' }),
    R(8, { 'First Name': 'Ok', 'Last Name': 'Y', Email: 'ok@notortusclub.com.example', 'LinkedIn URL': 'https://linkedin.com/in/ok-y' }),
  ]});
  const hits = out.blockers.filter(f => f.check === 'blocklist_match');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rowIndex, 7);
});

test('blocklist applies to ALL modes incl. warm message_only (operator decision 2026-07-10)', () => {
  const out = lintLeads({ ...BASE, mode: 'message_only', blocklist: [IBM], rows: [
    R(44, { 'First Name': 'Ann', 'Last Name': 'Lee', Company: 'IBM', 'LinkedIn URL': 'https://linkedin.com/in/ann-lee-ibm' }),
  ]});
  assert.equal(out.blockers.filter(f => f.check === 'blocklist_match').length, 1);
});

test('empty_template_var warning counts affected rows', () => {
  const out = lintLeads({ ...BASE,
    templates: { connectionNote: 'Hi {first name} from {company}!' },
    rows: [
      R(2, { 'First Name': 'A', 'Last Name': 'B', Company: '', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
      R(3, { 'First Name': 'C', 'Last Name': 'D', Company: 'Acme', 'LinkedIn URL': 'https://linkedin.com/in/c-d2' }),
    ]});
  const w = out.warnings.find(f => f.check === 'empty_template_var');
  assert.ok(w);
  assert.match(w.detail, /\{company\}/);
  assert.match(w.detail, /1 row/);
});

test('runtime tokens (senderName) never warn — resolved at send time, not from the sheet', () => {
  const out = lintLeads({ ...BASE,
    templates: { connectionNote: 'Hi {first name}, {senderName} here from {senderFirstName}!' },
    rows: [
      R(2, { 'First Name': 'A', 'Last Name': 'B', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
    ]});
  assert.equal(out.warnings.find(f => f.check === 'empty_template_var'), undefined);
});

test('column_invalid when the configured column is missing from headers', () => {
  const out = lintLeads({ ...BASE, linkedinColumn: 'LinkedIn Url' /* typo */, rows: [
    R(2, { 'First Name': 'A', 'Last Name': 'B', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
  ]});
  assert.ok(out.blockers.find(f => f.check === 'column_invalid' && f.rowIndex === null));
});

test('ambiguous_tab blocker when no explicit gid and multiple tabs', () => {
  const out = lintLeads({ ...BASE, gidExplicit: false, tabCount: 4, rows: [
    R(2, { 'First Name': 'A', 'Last Name': 'B', 'LinkedIn URL': 'https://linkedin.com/in/a-b1' }),
  ]});
  assert.ok(out.blockers.find(f => f.check === 'ambiguous_tab'));
});

test('passed list confirms column + target count on a clean run', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(2, { 'First Name': 'Leon', 'Last Name': 'Katsnelson', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  assert.ok(out.passed.find(p => p.check === 'column_found'));
  assert.ok(out.passed.find(p => p.check === 'targets_found' && /1/.test(p.detail)));
});

// ── blocklistExcludedUrls helper ─────────────────────────────────────────────

const IBM_BLOCKLIST = [{ kind: 'company', value: 'IBM' }];
const IBM_ROW = { 'First Name': 'Alice', 'Last Name': 'Smith', 'LinkedIn URL': 'https://www.linkedin.com/in/alicesmith/', Company: 'IBM' };
const OTHER_ROW = { 'First Name': 'Bob', 'Last Name': 'Jones', 'LinkedIn URL': 'https://www.linkedin.com/in/bobjones/', Company: 'Acme' };

test('blocklistExcludedUrls: cold mode excludes IBM row', () => {
  const urls = blocklistExcludedUrls([IBM_ROW, OTHER_ROW], {
    linkedinColumn: 'LinkedIn URL',
    mode: 'connect_only',
    blocklist: IBM_BLOCKLIST,
  });
  assert.equal(urls.length, 1);
  assert.ok(urls[0].includes('alicesmith'));
});

test('blocklistExcludedUrls: warm message_only ALSO excludes the IBM row (operator decision 2026-07-10)', () => {
  const urls = blocklistExcludedUrls([IBM_ROW, OTHER_ROW], {
    linkedinColumn: 'LinkedIn URL',
    mode: 'message_only',
    blocklist: IBM_BLOCKLIST,
  });
  assert.deepEqual(urls, ['https://www.linkedin.com/in/alicesmith/']);
});

test('normalizeProfileUrl strips protocol, www, trailing slash, and query string', () => {
  assert.equal(normalizeProfileUrl('https://www.linkedin.com/in/janedoe/'), 'linkedin.com/in/janedoe');
  assert.equal(normalizeProfileUrl('http://linkedin.com/in/janedoe?trk=foo'), 'linkedin.com/in/janedoe');
  assert.equal(normalizeProfileUrl('HTTPS://LinkedIn.com/in/JaneDoe'), 'linkedin.com/in/janedoe');
  assert.equal(normalizeProfileUrl(''), '');
  assert.equal(normalizeProfileUrl(null), '');
});

test('previously stamped rows surface as a passed note, not silence', () => {
  const out = lintLeads({ ...BASE, rows: [
    R(5, { 'First Name': 'Cindy', 'Last Name': 'Siapno', Stage: 'Skipped: blocklist — IBM',
           'LinkedIn URL': 'https://www.linkedin.com/in/cindy-siapno-678b13313/' }),
    R(2, { 'First Name': 'Leon', 'Last Name': 'Katsnelson', 'LinkedIn URL': 'https://www.linkedin.com/in/leonkatsnelson/' }),
  ]});
  const note = out.passed.find((p) => p.check === 'previously_excluded');
  assert.ok(note);
  assert.match(note.detail, /1 row/);
  assert.match(note.detail, /5/);
  assert.equal(out.blockers.length, 0);
  assert.equal(out.targetCount, 1);
});
