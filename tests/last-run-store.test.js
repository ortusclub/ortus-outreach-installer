// tests/last-run-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { readLastRun, writeLastRun } from '../src/last-run-store.js';

function tmpFile(name) {
  const dir = mkdtempSync(join(os.tmpdir(), 'lastrun-'));
  return join(dir, name);
}

test('writeLastRun then readLastRun round-trips the object', () => {
  const p = tmpFile('snap.json');
  const snap = { mode: 'connect_and_introduce', profileIds: ['a', 'b'], sheetUrl: 'https://x', templates: { connectionNote: 'hi' } };
  writeLastRun(p, snap);
  assert.ok(existsSync(p));
  assert.deepEqual(readLastRun(p), snap);
});

test('readLastRun returns null for a missing file', () => {
  assert.equal(readLastRun(tmpFile('does-not-exist.json')), null);
});

test('readLastRun returns null for corrupt JSON (never throws)', () => {
  const p = tmpFile('corrupt.json');
  writeFileSync(p, '{ not valid json', 'utf8');
  assert.equal(readLastRun(p), null);
});

test('writeLastRun overwrites a previous snapshot', () => {
  const p = tmpFile('snap.json');
  writeLastRun(p, { a: 1 });
  writeLastRun(p, { b: 2 });
  assert.deepEqual(readLastRun(p), { b: 2 });
});
