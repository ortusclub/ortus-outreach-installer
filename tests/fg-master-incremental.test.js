import test from 'node:test';
import assert from 'node:assert/strict';
import { newRowsOnly, FG_MASTER_HEADER } from '../src/connections/fg-master.js';
import { writeFgMaster, readFgMasterKeys } from '../src/connections/fg-sync.js';

const I_URL = FG_MASTER_HEADER.indexOf('LinkedIn URL');
const I_MEMBER = FG_MASTER_HEADER.indexOf('Member ID');

function row({ url = '', memberId = '' }) {
  const r = new Array(FG_MASTER_HEADER.length).fill('');
  r[I_URL] = url;
  r[I_MEMBER] = memberId;
  return r;
}

test('newRowsOnly keeps only people not already keyed in the tab', () => {
  const rows = [
    row({ url: 'https://www.linkedin.com/in/ada/', memberId: '111' }),
    row({ url: 'https://www.linkedin.com/in/bob/' }),
    row({ url: 'https://www.linkedin.com/in/cy/', memberId: '333' }),
  ];
  // Ada by Member ID, Bob by normalised URL — the two identity forms in the tab.
  const existing = new Set(['111', 'linkedin.com/in/bob']);
  const out = newRowsOnly(rows, existing);
  assert.equal(out.skipped, 2);
  assert.deepEqual(out.rows.map((r) => r[I_MEMBER]), ['333']);
});

test('newRowsOnly with no existing keys is a passthrough', () => {
  const rows = [row({ url: 'https://www.linkedin.com/in/ada/' })];
  assert.equal(newRowsOnly(rows, new Set()).rows.length, 1);
  assert.equal(newRowsOnly(rows, null).rows.length, 1);
});

test('writeFgMaster with appendAt never replaces, and lands after the last row', async () => {
  const calls = [];
  const rows = [row({ url: 'a' }), row({ url: 'b' }), row({ url: 'c' })];
  const out = await writeFgMaster(rows, {
    appendAt: 1002, chunkSize: 2, post: async (p) => { calls.push(p); return { ok: true }; },
  });
  assert.equal(out.written, 3);
  assert.deepEqual(calls.map((c) => c.mode), ['append', 'append']);
  assert.deepEqual(calls.map((c) => c.startRow), [1002, 1004]);
  // The first incremental chunk claims the fence a full rebuild would have set.
  assert.deepEqual(calls.map((c) => !!c.claim), [true, false]);
});

test('an incremental build with nothing new does not touch the sheet', async () => {
  let posted = 0;
  const out = await writeFgMaster([], { appendAt: 500, post: async () => { posted += 1; return {}; } });
  assert.equal(posted, 0);
  assert.equal(out.written, 0);
});

test('a full build with no rows still clears the tab', async () => {
  const calls = [];
  await writeFgMaster([], { post: async (p) => { calls.push(p); return {}; } });
  assert.deepEqual(calls.map((c) => c.mode), ['replace']);
});

test('readFgMasterKeys pages until the tab is exhausted', async () => {
  const pages = [
    { exists: true, rows: 5, read: 3, keys: '111\n222\n333' },
    { exists: true, rows: 5, read: 2, keys: '444\n555' },
  ];
  const seen = [];
  const got = await readFgMasterKeys({
    pageSize: 3,
    post: async (p) => { seen.push(p.offset); return pages[seen.length - 1]; },
  });
  assert.deepEqual(seen, [0, 3]);
  assert.equal(got.rows, 5);
  assert.deepEqual([...got.keys], ['111', '222', '333', '444', '555']);
});

test('readFgMasterKeys reports a missing tab instead of pretending it is empty', async () => {
  const got = await readFgMasterKeys({ post: async () => ({ exists: false, rows: 0, read: 0, keys: '' }) });
  assert.equal(got.exists, false);
  assert.equal(got.keys.size, 0);
});

test('readFgMasterKeys stops when a page reads nothing', async () => {
  let n = 0;
  const got = await readFgMasterKeys({
    post: async () => { n += 1; return { exists: true, rows: 99, read: 0, keys: '' }; },
  });
  assert.equal(n, 1);
  assert.equal(got.keys.size, 0);
});
