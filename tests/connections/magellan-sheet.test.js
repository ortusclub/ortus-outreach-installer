import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountsRows, logRows, importRows, planRows, connectionsRowsForAccount, tabNameFor,
  publish, resetPublished,
  CONNECTIONS_HEADER, ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB,
} from '../../src/connections/magellan-sheet.js';
import { diagnose } from '../../src/connections/magellan-diagnose.js';

// The layout is Abygael's cleaned sheet, so the columns are a contract.
test('the connections tab has exactly the cleaned-sheet columns, in order', () => {
  assert.deepEqual(CONNECTIONS_HEADER, ['LinkedIn Membership ID', 'Location', 'First Name',
    'Last Name', 'LinkedIn Bio', 'Company Name', 'Job Title', 'Email',
    'Linkedin First Connections']);
});

test('a connection becomes a cleaned-sheet row, keyed by the synthetic email', () => {
  const rows = connectionsRowsForAccount('karl@ortus.solutions', [
    { memberId: '14258192', firstName: 'Anand', lastName: 'Choudha', slug: 'anand-choudha',
      company: 'Hive Pro Inc', jobTitle: 'CEO and Founder' },
  ]);
  assert.deepEqual(rows[0], ['14258192', '', 'Anand', 'Choudha',
    'https://www.linkedin.com/in/anand-choudha', 'Hive Pro Inc', 'CEO and Founder',
    '14258192@linkedinmembership.id', 'karl@ortus.solutions']);
});

// No member id means no HubSpot key — a half-row would just be noise.
test('people without a member id are left out', () => {
  const rows = connectionsRowsForAccount('a@o.com', [
    { memberId: '', firstName: 'Hidden', slug: '' },
    { memberId: '7', firstName: 'Real', slug: 'real' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0][2], 'Real');
});

test('a tab is named after the account, with the characters Sheets rejects swapped out', () => {
  assert.equal(tabNameFor('nikki@ortus.solutions'), 'nikki@ortus.solutions');
  assert.equal(tabNameFor('a/b[c]*d?e:f'), 'a-b-c--d-e-f');
});

test('a failed account carries its cause and its fix, not a stack trace', () => {
  const rows = accountsRows({
    perAccount: [{ account: 'a@o.com', error: 'Cr24', diagnosis: diagnose('Cr24') }],
  });
  assert.equal(rows[0][1], 'Failed');
  assert.match(rows[0][6], /never opened/);
  assert.match(rows[0][7], /extensions cache/i);
});

test('a collected account carries its counts', () => {
  const rows = accountsRows({
    perAccount: [{ account: 'a@o.com', total: 1259, withMemberId: 1241, hidden: 18, collectedAt: 'T' }],
  });
  assert.deepEqual(rows[0], ['a@o.com', 'Collected', '1259', '1241', '18', 'T', '', '']);
});

// The whole point of the tab: a 7,000-connection account must not look idle.
test('the account being read right now shows its live count', () => {
  const rows = accountsRows({
    running: true, perAccount: [],
    current: { account: 'nikki@o.com', count: 1240, pages: 31, total: 7213 },
  });
  assert.equal(rows[0][1], 'Reading now');
  assert.equal(rows[0][2], '1240');
  assert.match(rows[0][6], /page 31 of about 7213/);
});

test('the live row disappears once the account has landed', () => {
  const rows = accountsRows({
    running: true,
    perAccount: [{ account: 'a@o.com', total: 7, withMemberId: 7, hidden: 0 }],
    current: { account: 'a@o.com', count: 7, pages: 1 },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0][1], 'Collected');
});

test('log lines split into time and event', () => {
  const rows = logRows({ log: ['[2026-08-10T10:00:00.000Z] ▶ Collecting 2 accounts.', 'no timestamp'] });
  assert.deepEqual(rows[0], ['2026-08-10T10:00:00.000Z', '▶ Collecting 2 accounts.']);
  assert.deepEqual(rows[1], ['', 'no timestamp']);
});

test('import rows are per account, with the first errors spelled out', () => {
  const rows = importRows({
    perAccount: [{ account: 'a@o.com', created: 10, updated: 2, extraEmails: 1, errors: [{ stage: 'create', error: 'boom' }] }],
  });
  assert.deepEqual(rows[0].slice(0, 5), ['a@o.com', '10', '2', '1', '1']);
  assert.equal(rows[0][5], 'create: boom');
});

test('no import yet means no import tab', () => {
  assert.deepEqual(importRows(null), []);
});

// Collect Nikki, Antonio and Milee and you get three tabs, one per email.
test('every collected account gets its own tab, named after it', async () => {
  resetPublished();
  const calls = [];
  const r = await publish(
    { perAccount: [{ account: 'nikki@o.com' }, { account: 'antonio@o.com' }, { account: 'bad@o.com', error: 'Cr24' }], log: [] },
    {
      read: () => [{ memberId: '1', firstName: 'A', slug: 's' }],
      write: async (tab) => { calls.push(tab); return { url: 'https://sheet' }; },
    },
  );
  assert.equal(r.written, true);
  assert.equal(r.url, 'https://sheet');
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB, 'nikki@o.com', 'antonio@o.com']);
});

// A 300-account sweep publishes after every account; resending all 300 tabs
// each time would take longer than the collection itself.
test('an account tab is not rewritten when its numbers have not changed', async () => {
  resetPublished();
  const state = { perAccount: [{ account: 'a@o.com' }], log: [] };
  const deps = { read: () => [{ memberId: '1', slug: 's' }] };
  const first = [];
  await publish(state, { ...deps, write: async (tab) => first.push(tab) });
  const second = [];
  await publish(state, { ...deps, write: async (tab) => second.push(tab) });
  assert.ok(first.includes('a@o.com'));
  assert.deepEqual(second, [ACCOUNTS_TAB, LOG_TAB], 'only the run tabs were refreshed');
});

test('publish adds the import tab once an import has run', async () => {
  resetPublished();
  const calls = [];
  await publish(
    { perAccount: [], log: [], imported: { perAccount: [{ account: 'a@o.com', created: 1 }] } },
    { read: () => [], write: async (tab) => calls.push(tab) },
  );
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB]);
});

// A dead sheet must never stop a sweep.
test('a Google failure is reported, not thrown', async () => {
  const r = await publish({ perAccount: [], log: [] }, {
    read: () => [], write: async () => { throw new Error('Timeout di blocco'); },
  });
  assert.equal(r.written, false);
  assert.match(r.error, /Timeout di blocco/);
});

test('a second publish is skipped while the first is still in flight', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = publish({ perAccount: [], log: [] }, { read: () => [], write: () => gate });
  const second = await publish({ perAccount: [], log: [] }, { read: () => [], write: async () => {} });
  assert.equal(second.written, false);
  assert.match(second.skipped, /already in flight/);
  release();
  await first;
});

test('the Plan tab says, per person, what Import would do', () => {
  const rows = planRows({
    preview: {
      accounts: ['a@o.com'],
      totals: { created: 1, updated: 1, hidden: 1 },
    },
  }, () => ([
    { memberId: '111', firstName: 'New', lastName: 'Person', slug: 'new-person', existingId: null },
    { memberId: '222', firstName: 'Known', lastName: 'Person', slug: 'known-person', existingId: '900' },
    { memberId: '', firstName: '', lastName: '', slug: '', existingId: null },
  ]));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 3), ['a@o.com', 'New', 'Person']);
  assert.equal(rows[0][4], 'Will be added');
  assert.equal(rows[1][4], 'Already in HubSpot — we note the connection, nothing else changes');
  assert.equal(rows[2][4], 'Hidden by LinkedIn — nothing we can do');
});

test('planRows is empty when Check has not run', () => {
  assert.deepEqual(planRows({}, () => []), []);
});
