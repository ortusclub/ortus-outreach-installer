// Unit coverage for relaunchHistoryEntry — pure-helper test (no HTTP
// listener). Mirrors the existing test style in this repo (see
// campaign-registry.test.js, monitoring-persistence.test.js).
//
// Redirects data writes to a per-run temp dir via ORTUS_DATA_DIR. Because
// paths.js reads that env var ONCE at module-load time, the var must be
// set before paths.js is ever imported — including transitively. Static
// ES `import` statements are hoisted (they evaluate before the module
// body), so we set the env var here and use a top-level `await import()`
// to load the helpers AFTER the assignment runs. This is the only way to
// guarantee paths.js sees the redirected ROOT.
//
// Tests share a single history.json on disk, so they're grouped in a
// describe() block with concurrency:1 to run serially — otherwise the
// node:test default would run them in parallel and the file-state
// resets would race.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-history-relaunch-tests');
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;

const HIST_PATH = path.join(TEST_DATA_DIR, 'history.json');
const QUEUE_PATH = path.join(TEST_DATA_DIR, 'queued-campaigns.json');

// Dynamic imports — these run AFTER the env var is set, so paths.js
// resolves ROOT to TEST_DATA_DIR rather than the real ./data.
const { relaunchHistoryEntry } = await import('../src/history-helpers.js');
const { getQueue, clearQueue } = await import('../src/campaign-queue.js');

function writeHistory(arr) {
  fs.writeFileSync(HIST_PATH, JSON.stringify(arr, null, 2), 'utf-8');
}

async function resetState(hist) {
  writeHistory(hist);
  try { fs.unlinkSync(QUEUE_PATH); } catch { /* fine */ }
  await clearQueue();
}

describe('relaunchHistoryEntry', { concurrency: 1 }, () => {
  test('enqueues a copy with " (rerun)" suffix', async () => {
    await resetState([{
      date: '2026-05-26T10:00:00Z',
      name: 'Test Campaign',
      mode: 'connect_only',
      settings: { profileIds: ['p1'], sheetUrl: 'https://x', dailyLimit: 20 },
    }]);

    const res = await relaunchHistoryEntry(0);
    assert.equal(res.ok, true);
    assert.ok(res.entry);
    assert.equal(res.entry.config.name, 'Test Campaign (rerun)');
    assert.equal(res.entry.config.mode, 'connect_only');
    assert.deepEqual(res.entry.config.profileIds, ['p1']);

    const queue = await getQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0].id, res.entry.id);
  });

  test('preserves owner from history entry if present', async () => {
    await resetState([{
      date: '2026-05-26T10:00:00Z',
      name: 'Owned',
      mode: 'connect_only',
      owner: 'ortus@ortusclub.com',
      settings: { profileIds: ['p1'], sheetUrl: 'https://x', dailyLimit: 20 },
    }]);

    const res = await relaunchHistoryEntry(0);
    assert.equal(res.ok, true);
    assert.equal(res.entry.owner, 'ortus@ortusclub.com');
  });

  test('out-of-range idx returns ok:false', async () => {
    await resetState([]);
    const res = await relaunchHistoryEntry(0);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'out_of_range');
  });

  test('invalid idx returns ok:false', async () => {
    await resetState([{ name: 'x', mode: 'CC', settings: {} }]);
    const res = await relaunchHistoryEntry(-1);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid_idx');
  });

  test('missing settings returns ok:false', async () => {
    await resetState([{ name: 'legacy', mode: 'CC' /* no settings */ }]);
    const res = await relaunchHistoryEntry(0);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'missing_settings');
  });
});
