// Unit coverage for readCampaignLog — per-campaign log filter helper.
// Pure-helper test (no HTTP listener); see history-relaunch.test.js for
// the rationale on the dynamic-import pattern + ORTUS_DATA_DIR redirect.
//
// Tests share one history.json + campaign.log on disk so they're grouped
// in a describe() block with concurrency:1 to run serially.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'ortus-history-log-tests');
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.ORTUS_DATA_DIR = TEST_DATA_DIR;

const HIST_PATH = path.join(TEST_DATA_DIR, 'history.json');
const LOG_PATH = path.join(TEST_DATA_DIR, 'campaign.log');

// Dynamic import so the env var above is in effect when paths.js loads.
const { readCampaignLog } = await import('../src/history-helpers.js');

function writeHistory(arr) {
  fs.writeFileSync(HIST_PATH, JSON.stringify(arr, null, 2), 'utf-8');
}
function writeLog(lines) {
  fs.writeFileSync(LOG_PATH, lines.join('\n'), 'utf-8');
}
function removeLog() {
  try { fs.unlinkSync(LOG_PATH); } catch { /* fine */ }
}

describe('readCampaignLog', { concurrency: 1 }, () => {
  test('returns only lines mentioning the campaign name', async () => {
    writeHistory([{ name: 'UniqueTestName', mode: 'CC' }]);
    writeLog([
      '2026-05-26T10:00:00Z [campaign:UniqueTestName] start',
      '2026-05-26T10:01:00Z [campaign:Other] noise',
      '2026-05-26T10:02:00Z [campaign:UniqueTestName] sent to Alice',
    ]);
    const res = await readCampaignLog(0);
    assert.equal(res.ok, true);
    assert.equal(res.lines.length, 2);
    assert.ok(res.lines.every(l => l.includes('UniqueTestName')));
    assert.equal(res.total, 2);
    assert.equal(res.name, 'UniqueTestName');
  });

  test('caps result at last 500 matching lines', async () => {
    writeHistory([{ name: 'Bulky', mode: 'CC' }]);
    const lines = [];
    for (let i = 0; i < 600; i++) lines.push(`line ${i} [campaign:Bulky] hit`);
    writeLog(lines);
    const res = await readCampaignLog(0);
    assert.equal(res.ok, true);
    assert.equal(res.lines.length, 500);
    assert.equal(res.total, 600);
    // last 500 means slice(-500) — so first kept line is "line 100"
    assert.ok(res.lines[0].includes('line 100'));
    assert.ok(res.lines.at(-1).includes('line 599'));
  });

  test('missing log file returns ok:true with empty lines', async () => {
    writeHistory([{ name: 'Ghost', mode: 'CC' }]);
    removeLog();
    const res = await readCampaignLog(0);
    assert.equal(res.ok, true);
    assert.deepEqual(res.lines, []);
    assert.equal(res.total, 0);
  });

  test('out-of-range idx returns ok:false', async () => {
    writeHistory([]);
    const res = await readCampaignLog(0);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'out_of_range');
  });

  test('invalid idx returns ok:false', async () => {
    writeHistory([{ name: 'x', mode: 'CC' }]);
    const res = await readCampaignLog(-1);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'invalid_idx');
  });

  test('entry with empty name returns ok:true with empty lines (no filter possible)', async () => {
    writeHistory([{ name: '', mode: 'CC' }]);
    writeLog(['some line', 'another line']);
    const res = await readCampaignLog(0);
    assert.equal(res.ok, true);
    assert.deepEqual(res.lines, []);
  });
});
