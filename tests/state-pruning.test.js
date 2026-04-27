import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — given a `processed` map and a cutoff timestamp, return a
// new map with entries older than the cutoff dropped. Mirrors the prune
// loop inside loadState (W3-D1) so the contract is documented + locked.

function pruneProcessed(processed, cutoffMs) {
  const out = {};
  let pruned = 0;
  for (const [url, entry] of Object.entries(processed || {})) {
    const ts = entry?.date ? Date.parse(entry.date) : NaN;
    if (Number.isFinite(ts) && ts < cutoffMs) { pruned++; continue; }
    out[url] = entry;
  }
  return { processed: out, pruned };
}

test('keeps recent entries, drops old ones', () => {
  const now = Date.now();
  const recent = new Date(now - 10 * 86400000).toISOString(); // 10 days ago
  const old    = new Date(now - 80 * 86400000).toISOString(); // 80 days ago
  const cutoff = now - 60 * 86400000; // keep entries newer than 60d
  const input = {
    'url-a': { profileId: 'p1', date: recent },
    'url-b': { profileId: 'p1', date: old },
  };
  const { processed, pruned } = pruneProcessed(input, cutoff);
  assert.equal(pruned, 1);
  assert.deepEqual(Object.keys(processed), ['url-a']);
});

test('keeps entries with malformed/missing date (defensive: never drops if we cannot date it)', () => {
  const cutoff = Date.now() - 60 * 86400000;
  const input = {
    'no-date':   { profileId: 'p1' },
    'bad-date':  { profileId: 'p1', date: 'not a real date' },
    'null-date': { profileId: 'p1', date: null },
  };
  const { processed, pruned } = pruneProcessed(input, cutoff);
  assert.equal(pruned, 0);
  assert.equal(Object.keys(processed).length, 3);
});

test('empty input is empty output', () => {
  const { processed, pruned } = pruneProcessed({}, Date.now());
  assert.deepEqual(processed, {});
  assert.equal(pruned, 0);
});

test('null input treated as empty', () => {
  const { processed, pruned } = pruneProcessed(null, Date.now());
  assert.deepEqual(processed, {});
  assert.equal(pruned, 0);
});
