import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FG_LIST_HEADER, splitName, normUrl, inviteIdentity, invertAccountEmails, mapHeader,
  listRowFromContact, listRowFromFgRow, parseListRows,
} from '../src/connections/fg-list.js';

const EMAIL_MAP = {
  'ada@ortus.example': 'pid_ada',
  'grace@ortus.example': 'pid_grace',
};

test('splitName handles empty, single, and multi-token names', () => {
  assert.deepEqual(splitName(''), { first: '', last: '' });
  assert.deepEqual(splitName('Ada'), { first: 'Ada', last: '' });
  assert.deepEqual(splitName('Ada Lovelace'), { first: 'Ada', last: 'Lovelace' });
  assert.deepEqual(splitName('  Ada  Lovelace King '), { first: 'Ada', last: 'Lovelace King' });
});

test('normUrl strips scheme/www/trailing-slash/query and lower-cases', () => {
  assert.equal(normUrl('https://www.linkedin.com/in/Ada/'), 'linkedin.com/in/ada');
  assert.equal(normUrl('http://linkedin.com/in/ada?foo=1#x'), 'linkedin.com/in/ada');
  assert.equal(normUrl('https://www.linkedin.com/in/ada'), 'linkedin.com/in/ada'); // same key as the slashed form
  assert.equal(normUrl(''), '');
});

test('inviteIdentity prefers Member ID, falls back to normalised URL', () => {
  assert.equal(inviteIdentity({ memberId: '12345', url: 'https://li/ada' }), '12345');
  assert.equal(inviteIdentity({ memberId: '', url: 'https://www.linkedin.com/in/Ada/' }), 'linkedin.com/in/ada');
});

test('invertAccountEmails lower-cases, skips blanks, and reports collisions', () => {
  const r = invertAccountEmails({
    pid_ada: 'Ada@Ortus.Example',
    pid_grace: 'grace@ortus.example',
    pid_blank: '',
    pid_dup: 'ada@ortus.example',   // same email as pid_ada → collision, first wins
  });
  assert.equal(r.emailToProfileId['ada@ortus.example'], 'pid_ada');
  assert.equal(r.emailToProfileId['grace@ortus.example'], 'pid_grace');
  assert.equal(r.emailToProfileId['pid_blank'], undefined);
  assert.deepEqual(r.collisions, ['ada@ortus.example']);
});

test('mapHeader matches aliases regardless of order/casing', () => {
  const idx = mapHeader(['Company', 'LinkedIn', 'Account', 'First', 'Surname', 'Role', 'Status', 'Member ID']);
  assert.equal(idx.company, 0);
  assert.equal(idx.url, 1);
  assert.equal(idx.accountEmail, 2);
  assert.equal(idx.firstName, 3);
  assert.equal(idx.lastName, 4);
  assert.equal(idx.title, 5);
  assert.equal(idx.status, 6);
  assert.equal(idx.memberId, 7);
});

test('listRowFromContact yields the unified list+ledger row', () => {
  const row = listRowFromContact(
    { firstname: 'Ada', lastname: 'Lovelace', linkedinbio: 'https://li/ada', jobtitle: 'CMO', company: 'Engines', linkedin_membership_id: '12345' },
    { accountEmail: 'Ada@Ortus.Example' },
  );
  assert.deepEqual(row, ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', 'Queued', '', '', '12345']);
  assert.equal(row.length, FG_LIST_HEADER.length);
});

test('listRowFromFgRow splits the name, reorders, and carries Member ID', () => {
  // FG_HEADER order: Target Name, LinkedIn URL, Member ID, Company, Job Title, ...
  const fgRow = ['Grace Hopper', 'https://li/grace', '67890', 'US Navy', 'Rear Admiral'];
  const row = listRowFromFgRow(fgRow, { accountEmail: 'grace@ortus.example' });
  assert.deepEqual(row, ['Grace', 'Hopper', 'https://li/grace', 'Rear Admiral', 'US Navy', 'grace@ortus.example', 'Queued', '', '', '67890']);
});

test('parseListRows builds routed leads and groups per account', () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', '12345'],
    ['Grace', 'Hopper', 'https://li/grace', 'Admiral', 'Navy', 'grace@ortus.example', '', '', '', '67890'],
    ['Alan', 'Turing', 'https://li/alan', 'Head of Growth', 'GC&CS', 'ada@ortus.example', '', '', '', ''],
  ];
  const { leads, perAccount, skipped } = parseListRows(rows, { emailToProfileId: EMAIL_MAP });

  assert.equal(skipped.length, 0);
  assert.equal(leads.length, 3);
  assert.equal(leads[0].routeAccount, 'pid_ada');
  assert.equal(leads[1].routeAccount, 'pid_grace');
  assert.equal(leads[2].routeAccount, 'pid_ada');
  assert.equal(leads[0].leadUrl, 'https://li/ada');
  assert.equal(leads[0].fullName, 'Ada Lovelace');
  assert.equal(leads[0].row.memberId, '12345');
  assert.equal(leads[0].memberUrn, null);

  const ada = perAccount.find((a) => a.profileId === 'pid_ada');
  const grace = perAccount.find((a) => a.profileId === 'pid_grace');
  assert.equal(ada.count, 2);
  assert.equal(grace.count, 1);
  assert.equal(ada.account, 'ada@ortus.example');
  assert.equal(ada.rowsByUrl['https://li/ada'], '12345');  // member-id writeback preserved
  assert.equal(ada.rowsByUrl['https://li/alan'], '');       // BYO row → URL-keyed
});

test('parseListRows tolerates reordered/renamed headers', () => {
  const rows = [
    ['Account', 'Profile URL', 'First', 'Surname', 'Company', 'Role'],
    ['ADA@ortus.example', 'https://li/ada', 'Ada', 'Lovelace', 'Engines', 'CMO'],
  ];
  const { leads, skipped } = parseListRows(rows, { emailToProfileId: EMAIL_MAP });
  assert.equal(skipped.length, 0);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].routeAccount, 'pid_ada');   // case-insensitive email match
  assert.equal(leads[0].row.title, 'CMO');
});

test('parseListRows de-dupes by identity across URL formatting differences', () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', 'https://www.linkedin.com/in/ada', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', ''],
    ['Ada', 'Lovelace', 'http://linkedin.com/in/ada/', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', ''], // same person, diff URL text
  ];
  const { leads, skipped } = parseListRows(rows, { emailToProfileId: EMAIL_MAP });
  assert.equal(leads.length, 1);
  assert.deepEqual(skipped.map((s) => [s.rowNumber, s.reason]), [[3, 'duplicate person']]);
});

test('parseListRows skips bad rows with a reason and 1-based sheet row number', () => {
  const rows = [
    FG_LIST_HEADER,
    ['Ada', 'Lovelace', '', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', ''],            // row 2: no URL
    ['Grace', 'Hopper', 'https://li/grace', 'Admiral', 'Navy', '', '', '', '', ''],            // row 3: no account
    ['Alan', 'Turing', 'https://li/alan', 'Growth', 'GC&CS', 'nobody@x.com', '', '', '', ''],  // row 4: unknown account
    ['Ada', 'Lovelace', 'https://li/ada', 'CMO', 'Engines', 'ada@ortus.example', '', '', '', ''], // row 5: ok
  ];
  const { leads, skipped } = parseListRows(rows, { emailToProfileId: EMAIL_MAP });
  assert.equal(leads.length, 1);
  assert.deepEqual(skipped.map((s) => [s.rowNumber, s.reason]), [
    [2, 'missing LinkedIn URL'],
    [3, 'missing Account Email'],
    [4, 'unknown account email "nobody@x.com"'],
  ]);
});

test('parseListRows returns empty for header-only or empty input', () => {
  assert.deepEqual(parseListRows([], {}), { leads: [], perAccount: [], skipped: [] });
  assert.deepEqual(parseListRows([FG_LIST_HEADER], {}), { leads: [], perAccount: [], skipped: [] });
});
