import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __setDirForTests, appendScrapeLog, appendAction, readScrapeLog,
} from '../src/scrape-campaign-logs.js';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sclog-')); }

test('append then read returns lines in order with ts + message', async () => {
  __setDirForTests(tmpDir());
  await appendScrapeLog('sc_1', { ts: 1000, message: 'dispatched 2 jobs' });
  await appendScrapeLog('sc_1', { ts: 2000, message: 'job 1 done — 240 rows' });
  const lines = await readScrapeLog('sc_1', { limit: 10 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message, 'dispatched 2 jobs');
  assert.equal(lines[1].ts, 2000);
});

test('appendAction writes a who-did-it line, tagging admin', async () => {
  __setDirForTests(tmpDir());
  await appendAction('sc_2', { actor: 'alecx@ortus.solutions', admin: false, action: 'toggled OFF' });
  await appendAction('sc_2', { actor: 'antonio@ortusclub.com', admin: true, action: 'toggled ON' });
  const lines = await readScrapeLog('sc_2', { limit: 10 });
  assert.match(lines[0].message, /toggled OFF by alecx@ortus\.solutions/);
  assert.match(lines[1].message, /toggled ON by antonio@ortusclub\.com \(admin\)/);
});

test('read of an unknown campaign returns []', async () => {
  __setDirForTests(tmpDir());
  assert.deepEqual(await readScrapeLog('missing', { limit: 5 }), []);
});
