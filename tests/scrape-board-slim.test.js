import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { slimBoard, searchKey } from '../public/js/scrape-board.mjs';

// Measured on the live board 2026-08-13: GET /api/scrape/campaigns returned
// 20,404,966 bytes (288 strips, 2,247 jobs) and the client re-fetched and
// re-parsed ALL of it every 2.5s. Sales Nav search URLs averaged ~3.1KB each and
// were carried twice — 10.7MB on jobs, 7.0MB on campaigns — for a 60-char label
// and a count.

const URL_A = 'https://www.linkedin.com/sales/search/people?query=' + 'x'.repeat(3000);
const URL_B = 'https://www.linkedin.com/sales/search/people?query=' + 'y'.repeat(3000);

const BOARD = [{
  id: 'c1', name: 'Results 22', tabName: 'Results 22', status: 'running',
  sheetUrl: 'https://docs.google.com/s/1', searchUrls: [URL_A, URL_B],
  jobs: [
    { id: 'j1', runId: 'j1', state: 'running', profiles: 700, pages: 7, profileId: 'p1',
      searchUrl: URL_A, sheetUrl: 'https://docs.google.com/s/1',
      lockKey: 'lock-1', podId: 'pod-1', podIP: '10.1.2.3' },
  ],
}];

test('the heavy fields are gone', () => {
  const [c] = slimBoard(BOARD);
  assert.equal(c.searchUrls, undefined);
  const [j] = c.jobs;
  for (const k of ['searchUrl', 'sheetUrl', 'lockKey', 'podId', 'podIP']) {
    assert.equal(j[k], undefined, `job.${k} must not ride the list payload`);
  }
  // The whole point: an order-of-magnitude smaller poll.
  assert.ok(JSON.stringify(slimBoard(BOARD)).length * 10 < JSON.stringify(BOARD).length);
});

test('everything a strip renders survives', () => {
  const [c] = slimBoard(BOARD);
  assert.equal(c.searchCount, 2);          // "<b>2 searches</b>"
  assert.equal(c.name, 'Results 22');
  assert.equal(c.sheetUrl, 'https://docs.google.com/s/1'); // campaign-level: small, still used
  const [j] = c.jobs;
  assert.equal(j.searchLabel, URL_A.slice(0, 60));         // the expanded card's job label
  assert.equal(j.state, 'running');
  assert.equal(j.profiles, 700);
  assert.equal(j.id, 'j1');
  assert.equal(j.runId, 'j1');             // log scoping keys off this
});

test('search keys still match the launch registry', () => {
  // _snEnrich backfills a strip's name/owner from localStorage keyed by the
  // dispatched search URL. With URLs gone from the payload, the hash is the only
  // way that lookup can still land.
  const [c] = slimBoard(BOARD);
  assert.deepEqual(c.searchKeys, [searchKey(URL_A), searchKey(URL_B)]);
  assert.notEqual(searchKey(URL_A), searchKey(URL_B));
  assert.equal(searchKey(URL_A), searchKey(URL_A));
  assert.equal(searchKey(''), '');
  // Sales Nav URLs share a long prefix, so a truncated URL would collide for
  // every search on the board. The hash must depend on the tail.
  assert.notEqual(searchKey(URL_A.slice(0, 60) + '1'), searchKey(URL_A.slice(0, 60) + '2'));
});

test('malformed input never takes down the board route', () => {
  assert.deepEqual(slimBoard(null), []);
  assert.deepEqual(slimBoard([{ id: 'x' }]), [{ id: 'x', searchCount: 0, searchKeys: [], jobs: [] }]);
});

// ── Wiring (source assertions) ──────────────────────────────────────────────
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the list route slims, the single-record route does not', () => {
  assert.match(SERVER, /res\.json\(\{ campaigns: slimBoard\(board\.campaigns\)/);
  // Open and Re-run read full search URLs from here; slimming it would silently
  // re-run a scrape with no searches.
  assert.match(SERVER, /const rec = \(board\.campaigns \|\| \[\]\)\.find\(\(c\) => c\.id === req\.params\.id\) \|\| null;\s*\n\s*res\.json\(\{ campaign: rec/);
});

test('the client reads the slim shape', () => {
  assert.match(APP, /_snLaunchReg\[searchKey\(searchUrl\)\] = \{ \.\.\.info, ts: Date\.now\(\) \};/);
  assert.match(APP, /for \(const k of \(c\.searchKeys \|\| \(c\.searchUrls \|\| \[\]\)\.map\(searchKey\)\)\)/);
  assert.match(APP, /const label = j\.searchLabel \|\|/);
  assert.match(APP, /c\.searchCount != null \? c\.searchCount/);
});

// ── Connection-pool starvation ──────────────────────────────────────────────
// Measured 2026-08-13, after the payload slimming above: the board's 2.5s timer
// was ticking (6 probes in 15s) on a visible, correctly-routed board, and still
// issued ONE request in 75 seconds — that request never even got response
// headers. CDP showed 7 requests open at once, six of them
// /api/campaign/cloud/:id/leads at 13-16s each. Chromium allows SIX connections
// per host, so the cloud board's unbounded Promise.all fan-out was consuming the
// entire pool and every other poller in the page starved behind it.
test('the cloud fan-out is bounded so other pollers keep a connection', () => {
  assert.match(APP, /async function _mapLimit\(items, limit, fn\)/);
  assert.match(APP, /const CLOUD_FANOUT_LIMIT = 3;/);
  assert.ok(CLOUD_FANOUT_LIMIT_OK(), 'cloud fan-outs must go through _mapLimit');
  function CLOUD_FANOUT_LIMIT_OK() {
    return APP.includes('await _mapLimit(campaigns, CLOUD_FANOUT_LIMIT,')
      && APP.includes('await _mapLimit(cloudCamps, CLOUD_FANOUT_LIMIT,')
      && !/await Promise\.all\((campaigns|cloudCamps)\.map\(/.test(APP);
  }
});

test('cloud detail is fetched in one request, not one per campaign', () => {
  // 89 cloud campaigns => 89 requests => the pool stayed full for minutes. Node
  // has no six-per-host limit, so the fan-out belongs on the server.
  assert.match(SERVER, /app\.get\('\/api\/campaign\/cloud-details'/);
  assert.match(APP, /\/api\/campaign\/cloud-details\?ids=/);
  // The memo must not be per-request: a cache hit re-running reconcile on every
  // poll is exactly the load this removes.
  assert.match(SERVER, /function memoCloud\(key, fetcher, \{ ttlMs = CLOUD_MEMO_TTL_MS, onFresh \} = \{\}\)/);
  assert.doesNotMatch(SERVER, /if \(req\.method !== 'GET'\) _cloudMemo\.clear\(\);/);
  assert.match(SERVER, /_cloudMemo\.delete\(`campaign:\$\{id\}`\)/);
  assert.match(SERVER, /app\.get\('\/api\/campaign\/cloud-board-summary'/);
});

test('the FG status poll runs one chain, not one per entry point', () => {
  // fgtlPoll is called from FG view restore AND from launch; each call started
  // its own 2s chain. Six were observed open at once, the oldest 23s.
  assert.match(APP, /let _fgtlPolling = false;/);
  assert.match(APP, /function fgtlPoll\(\) \{\s*\n\s*if \(_fgtlPolling\) return;\s*\n\s*_fgtlPolling = true;/);
});
