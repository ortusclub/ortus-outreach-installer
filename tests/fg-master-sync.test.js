// tests/fg-master-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFgMaster } from '../src/connections/fg-sync.js';
import { FG_MASTER_HEADER } from '../src/connections/fg-master.js';

const rows = (n) => Array.from({ length: n }, (_, i) => [String(i), '', '', '', '', `u${i}`, '', '', '', '', '']);

test('writeFgMaster replaces on the first chunk and appends after', async () => {
  const calls = [];
  const post = async (payload) => { calls.push(payload); return { tab: payload.tab, written: payload.rows.length }; };
  const out = await writeFgMaster(rows(7), { chunkSize: 3, post });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].action, 'fgWriteMaster');
  assert.equal(calls[0].tab, 'FG Master');
  assert.deepEqual(calls[0].header, FG_MASTER_HEADER);
  assert.deepEqual(calls.map((c) => c.mode), ['replace', 'append', 'append']);
  assert.deepEqual(calls.map((c) => c.rows.length), [3, 3, 1]);
  assert.deepEqual(out, { tab: 'FG Master', written: 7, chunks: 3 });
});

test('writeFgMaster posts one header-only replace when there are no rows', async () => {
  const calls = [];
  const post = async (payload) => { calls.push(payload); return { written: 0 }; };
  const out = await writeFgMaster([], { post });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'replace');
  assert.deepEqual(calls[0].rows, []);
  assert.equal(out.written, 0);
});

test('writeFgMaster reports progress per chunk', async () => {
  const seen = [];
  const post = async () => ({ written: 0 });
  await writeFgMaster(rows(5), { chunkSize: 2, post, onProgress: (p) => seen.push(p) });
  assert.deepEqual(seen, [{ done: 2, total: 5 }, { done: 4, total: 5 }, { done: 5, total: 5 }]);
});

test('writeFgMaster throws with the chunk index when a chunk fails', async () => {
  let n = 0;
  const post = async () => { n += 1; return n === 2 ? { error: 'boom' } : { written: 0 }; };
  await assert.rejects(
    () => writeFgMaster(rows(6), { chunkSize: 2, post }),
    /chunk 2\/3.*boom/,
  );
});
