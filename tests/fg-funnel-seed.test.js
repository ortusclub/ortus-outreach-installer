// tests/fg-funnel-seed.test.js
// The manual funnel sheet (FUNNEL_I) folded into the FG Master rows: new people
// appended, accounts unioned, and manual invites stamped only where our own
// FG Invites ledger left the row blank.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseSeedCsv, mergeFunnelSeeds } from '../src/connections/fg-funnel-seed.js';

const FIRST_DEGREE = [
  '"Record ID","Name","Company","Job Title","Membership ID","Linkedin URL","Linkedin Bio","Duplication Check","Linkedin 1st Degree Connections","Invited","If Invited, who by"',
  '"1","Kevin Watt","Facebook","Messaging","30892","https://www.linkedin.com/sales/people/ACwAA1,rnp7,NAME_SEARCH/","https://www.linkedin.com/in/kevinwatt","1","miguel@ortus.solutions; gerielle@ortus.live","Invited","miguel@ortus.solutions"',
  '"2","Jacqui C.","F&I Sentinel","CMO","83596","","https://www.linkedin.com/in/jacqui","1","miguel@ortus.solutions","",""',
  '"","","","","","","","","","",""',
].join('\n');

// A master row in FG_MASTER_HEADER order.
const row = (o = {}) => [
  o.first || '', o.last || '', o.title || '', o.company || '', o.geo || '',
  o.url || '', o.memberId || '', o.accounts || '',
  o.invited || '', o.invitedAt || '', o.invitedBy || '',
];

test('parseCsv handles quoted commas, doubled quotes and embedded newlines', () => {
  const rows = parseCsv('"a,b","say ""hi""","two\nlines"\n"x","y","z"');
  assert.deepEqual(rows, [['a,b', 'say "hi"', 'two\nlines'], ['x', 'y', 'z']]);
});

test('parseSeedCsv prefers the /in/ Bio URL over the Sales Nav link and reads the invite columns', () => {
  const seeds = parseSeedCsv(FIRST_DEGREE);
  assert.equal(seeds.length, 2, 'blank line dropped');
  assert.deepEqual(seeds[0], {
    firstName: 'Kevin', lastName: 'Watt', title: 'Messaging', company: 'Facebook',
    url: 'https://www.linkedin.com/in/kevinwatt', memberId: '30892',
    accounts: ['miguel@ortus.solutions', 'gerielle@ortus.live'],
    invited: true, invitedBy: 'miguel@ortus.solutions',
  });
  assert.equal(seeds[1].invited, false);
});

test('parseSeedCsv de-dupes a person listed twice in one tab', () => {
  const twice = FIRST_DEGREE + '\n' + '"3","Kevin Watt","Facebook","Messaging","30892","","https://www.linkedin.com/in/kevinwatt","1","x@ortus.solutions","",""';
  assert.equal(parseSeedCsv(twice).length, 2);
});

test('mergeFunnelSeeds appends people the Connections DB has never seen', () => {
  const rows = [];
  const out = mergeFunnelSeeds(rows, parseSeedCsv(FIRST_DEGREE));
  assert.equal(out.added, 2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], row({
    first: 'Kevin', last: 'Watt', title: 'Messaging', company: 'Facebook',
    url: 'https://www.linkedin.com/in/kevinwatt', memberId: '30892',
    accounts: 'miguel@ortus.solutions, gerielle@ortus.live',
    invited: 'Invited', invitedBy: 'miguel@ortus.solutions',
  }));
  assert.equal(out.stamped, 2 - 1, 'only the Invited one is stamped');
});

test('mergeFunnelSeeds unions accounts onto a matching row instead of replacing them', () => {
  const rows = [row({ first: 'Kevin', last: 'Watt', url: 'https://linkedin.com/in/kevinwatt', memberId: '30892', accounts: 'ada@ortus.example, miguel@ortus.solutions' })];
  const out = mergeFunnelSeeds(rows, parseSeedCsv(FIRST_DEGREE));
  assert.equal(out.added, 1, 'only Jacqui is new');
  assert.equal(rows[0][7], 'ada@ortus.example, miguel@ortus.solutions, gerielle@ortus.live');
});

test('mergeFunnelSeeds matches by URL when the DB row has a Member ID the sheet lacks', () => {
  const rows = [row({ first: 'Jacqui', url: 'https://www.linkedin.com/in/Jacqui/', memberId: '999', accounts: 'ada@ortus.example' })];
  const out = mergeFunnelSeeds(rows, parseSeedCsv(FIRST_DEGREE));
  assert.equal(out.added, 1, 'Kevin is new, Jacqui matched on URL');
  assert.equal(rows[0][7], 'ada@ortus.example, miguel@ortus.solutions');
});

test('an FG Invites stamp always beats the manual sheet, and blanks are filled', () => {
  const rows = [row({ first: 'Kevin', url: 'https://linkedin.com/in/kevinwatt', memberId: '30892', invited: 'Invited', invitedAt: '2026-07-01 09:00 UTC', invitedBy: 'ada@ortus.example' })];
  const out = mergeFunnelSeeds(rows, parseSeedCsv(FIRST_DEGREE));
  assert.deepEqual(rows[0].slice(8), ['Invited', '2026-07-01 09:00 UTC', 'ada@ortus.example'], 'ledger row untouched');
  assert.equal(out.stamped, 0);
  assert.equal(rows[0][2], 'Messaging', 'blank title filled from the sheet');
  assert.equal(rows[0][3], 'Facebook', 'blank company filled from the sheet');
});
