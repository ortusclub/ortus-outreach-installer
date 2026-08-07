import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Measured 2026-08-07 against production: the engine's GET /api/jobs takes
// 7.7-10s and returns 14.7MB (2,807 jobs); grouping is 9ms and the override
// loop 1ms. The engine round trip WAS the latency, and it sat on the request
// path for three separate client paths. These pin the cache that took it off.
//
// server.js has no exports, so these are source assertions — the same approach
// mode-locks.test.js uses.

const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the board is served from an in-memory cache', () => {
  assert.match(SERVER, /let _scrapeBoard = null;/);
  assert.match(SERVER, /async function refreshScrapeBoard\(\)/);
  assert.match(SERVER, /async function getScrapeBoard\(\)/);
});

test('a stale board is returned immediately, not awaited', () => {
  // The whole point: past the TTL we kick a refresh and serve the stale board
  // in the same tick. Awaiting here would put the 8s engine fetch straight back
  // on the request path.
  const fn = SERVER.slice(SERVER.indexOf('async function getScrapeBoard()'), SERVER.indexOf("app.get('/api/scrape/campaigns'"));
  assert.match(fn, /refreshScrapeBoardOnce\(\)\.catch\(/);
  assert.equal(/await refreshScrapeBoardOnce\(\)[\s\S]*_scrapeBoard\.at > SCRAPE_BOARD_TTL/.test(fn), false);
  // Only the cold path (no cache at all) may block.
  assert.match(fn, /if \(!_scrapeBoard\) return refreshScrapeBoardOnce\(\);/);
});

test('a failed background refresh cannot break a good board', () => {
  const fn = SERVER.slice(SERVER.indexOf('async function getScrapeBoard()'), SERVER.indexOf("app.get('/api/scrape/campaigns'"));
  assert.match(fn, /\.catch\(\(\) => \{ \/\* keep serving the last good board \*\/ \}\)/);
});

test('concurrent refreshes collapse into one engine fetch', () => {
  // The board polls every 2.5s; without this a slow 8s refresh would stack
  // four overlapping 14.7MB fetches.
  assert.match(SERVER, /function refreshScrapeBoardOnce\(\)/);
  assert.match(SERVER, /if \(!_scrapeBoardInflight\)/);
  assert.match(SERVER, /_scrapeBoardInflight = refreshScrapeBoard\(\)\.finally\(/);
});

test('the board is warmed at boot so the first open is instant too', () => {
  assert.match(SERVER, /Sales Nav board: warmed/);
  // Must NOT be awaited — an 8s engine fetch would delay the server listening.
  assert.equal(SERVER.includes('await refreshScrapeBoardOnce()'), false, 'warm-up must not block boot');
});

test('there is a single-record route so callers stop pulling the whole list', () => {
  assert.match(SERVER, /app\.get\('\/api\/scrape\/campaigns\/:id',/);
});

test('Open and Re-run fetch one record, not the 22MB board', () => {
  for (const fnName of ['openScrapeSetupFor', 'rerunScrape']) {
    const start = APP.indexOf(`function ${fnName}(`);
    assert.ok(start > -1, `${fnName} must exist`);
    const body = APP.slice(start, start + 2600);
    assert.match(body, /fetch\(`\/api\/scrape\/campaigns\/\$\{encodeURIComponent\(cid\)\}`\)/,
      `${fnName} must fetch the single record`);
    assert.equal(/fetch\('\/api\/scrape\/campaigns'\)/.test(body), false,
      `${fnName} must not fetch the whole board`);
  }
});
