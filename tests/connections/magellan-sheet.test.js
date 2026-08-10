import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountsRows, logRows, importRows, publish,
  ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB,
} from '../../src/connections/magellan-sheet.js';
import { diagnose } from '../../src/connections/magellan-diagnose.js';

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
    running: true,
    perAccount: [],
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

test('publish writes the accounts and log tabs, and skips import until there is one', async () => {
  const calls = [];
  const r = await publish({ perAccount: [], log: [] }, { write: async (tab) => calls.push(tab) });
  assert.equal(r.written, true);
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB]);
});

test('publish adds the import tab once an import has run', async () => {
  const calls = [];
  await publish(
    { perAccount: [], log: [], imported: { perAccount: [{ account: 'a@o.com', created: 1 }] } },
    { write: async (tab) => calls.push(tab) },
  );
  assert.deepEqual(calls, [ACCOUNTS_TAB, LOG_TAB, IMPORT_TAB]);
});

// A dead sheet must never stop a sweep.
test('a Google failure is reported, not thrown', async () => {
  const r = await publish({ perAccount: [], log: [] }, {
    write: async () => { throw new Error('Timeout di blocco'); },
  });
  assert.equal(r.written, false);
  assert.match(r.error, /Timeout di blocco/);
});

test('a second publish is skipped while the first is still in flight', async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const first = publish({ perAccount: [], log: [] }, { write: () => gate });
  const second = await publish({ perAccount: [], log: [] }, { write: async () => {} });
  assert.equal(second.written, false);
  assert.match(second.skipped, /already in flight/);
  release();
  await first;
});
