// Unit coverage for archiveHistoryEntry + listHistory — pure-helper tests
// for the soft-archive flow on past campaigns. See the rationale block in
// tests/history-relaunch.test.js for why ORTUS_DATA_DIR is set before any
// import of paths.js (the helpers transitively pull it in).
//
// Tests share one history.json on disk, so they're grouped in a describe()
// block with concurrency:1 to run serially.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-history-archive-tests');
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;

const HIST_PATH = path.join(TEST_DATA_DIR, 'history.json');

// Dynamic import so the env var above is in effect when paths.js loads.
const { archiveHistoryEntry, listHistory } = await import('../src/history-helpers.js');

function writeHistory(arr) {
  fs.writeFileSync(HIST_PATH, JSON.stringify(arr, null, 2), 'utf-8');
}

describe('archiveHistoryEntry + listHistory', { concurrency: 1 }, () => {
  test('archiveHistoryEntry flips archived:true on the entry', async () => {
    writeHistory([
      { date: '2026-05-26T10:00:00Z', name: 'Test', mode: 'CC', settings: {} },
    ]);
    const res = await archiveHistoryEntry(0);
    assert.equal(res.ok, true);
    const after = JSON.parse(fs.readFileSync(HIST_PATH, 'utf-8'));
    assert.equal(after[0].archived, true);
  });

  test('archiveHistoryEntry — out-of-range idx returns ok:false', async () => {
    writeHistory([]);
    const res = await archiveHistoryEntry(0);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'out_of_range');
  });

  test('archiveHistoryEntry — invalid idx returns ok:false', async () => {
    writeHistory([{ name: 'x', mode: 'CC' }]);
    const res = await archiveHistoryEntry(-1);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid_idx');
  });

  test('listHistory({ includeArchived: false }) hides archived', async () => {
    writeHistory([
      { date: '1', name: 'A', mode: 'CC', archived: true },
      { date: '2', name: 'B', mode: 'CC' },
    ]);
    const list = await listHistory({ includeArchived: false });
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'B');
  });

  test('listHistory() default returns ALL entries (backwards compat)', async () => {
    writeHistory([
      { date: '1', name: 'A', mode: 'CC', archived: true },
      { date: '2', name: 'B', mode: 'CC' },
    ]);
    const list = await listHistory();
    assert.equal(list.length, 2);
  });
});
