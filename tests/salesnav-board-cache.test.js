import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Sales Nav board keeps no local state — every strip is derived from the
// engine's /api/jobs, measured at ~15MB / 2,807 jobs on 2026-08-07. Opening the
// tab therefore showed "Loading scrapes…" for a full cold round trip to the VM,
// every time, while the campaigns dashboard (local files) paints instantly.
//
// app.js is a browser bundle with no exports, so these are source assertions —
// the same approach mode-locks.test.js uses.

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

const OPEN_FN = APP.slice(
  APP.indexOf('async function openSalesNavBoard()'),
  APP.indexOf('window.openSalesNavBoard'),
);

test('the board has a persisted display cache', () => {
  assert.match(APP, /const SN_CACHE_KEY = 'snBoardCache1'/);
  assert.match(APP, /function _snSaveCache\(campaigns\)/);
  assert.match(APP, /function _snLoadCache\(\)/);
});

test('the cached board paints BEFORE any await', () => {
  // This is the whole point: an await before the first render puts a network
  // round trip back on the render path and the tab is empty again.
  //
  // 2026-08-13: the guarantee got STRONGER. openSalesNavBoard no longer awaits
  // anything at all, so rather than "the paint precedes the first await" this
  // now asserts there is nothing before the paint that could delay it.
  const paintAt = OPEN_FN.indexOf('renderSalesNavBoard(cached)');
  assert.ok(paintAt > -1, 'openSalesNavBoard must render the cache');
  assert.equal(/await /.test(OPEN_FN.slice(0, paintAt)), false,
    'nothing may be awaited before the cached paint');
});

test('a corrupt cache cannot block the live load', () => {
  assert.match(OPEN_FN, /try \{\s*renderSalesNavBoard\(cached\);/);
  // The live path runs regardless of what the cache did — and the poll TIMER is
  // installed without waiting on it. Awaiting the first fetch here used to leave
  // the board with no timer for as long as that fetch took (5-10s warm, 83s
  // measured during app boot), so the strips sat frozen and expanding a scrape
  // opened an empty shell.
  assert.match(OPEN_FN, /_snPollTimer = setInterval\(pollSalesNavBoard, 2500\);/);
  assert.match(OPEN_FN, /\n\s*pollSalesNavBoard\(\);/);
  assert.equal(/await pollSalesNavBoard\(\);/.test(OPEN_FN), false,
    'the first poll must not gate the timer');
});

test('cached statuses do not seed the handover detector', () => {
  // Comparing a fresh poll against an hour-old cache would fire phantom
  // "X stopped" / "launching Y" toasts on every open.
  assert.match(OPEN_FN, /_snPrevStatus = new Map\(\);/);
});

test('a successful poll refreshes the cache', () => {
  assert.match(APP, /renderSalesNavBoard\(d\.campaigns \|\| \[\]\);\s*\n\s*_snSaveCache\(d\.campaigns \|\| \[\]\);/);
});

test('quota failure shrinks the cache instead of dropping it', () => {
  assert.match(APP, /for \(const cap of \[80, 40, 15, 5\]\)/);
  assert.match(APP, /campaigns\.slice\(0, cap\)/);
});

test('cached strips keep their full search URLs', () => {
  // Action handlers (Re-run, Open) read search URLs off the rendered data, so a
  // truncated URL in the cache would fire a scrape at the wrong search. Cap the
  // NUMBER of strips, never the contents of one.
  const save = APP.slice(APP.indexOf('function _snSaveCache'), APP.indexOf('function _snLoadCache'));
  assert.equal(/\.slice\(0,\s*\d+\)\s*\)/.test(save.replace(/campaigns\.slice\(0, cap\)/g, '')), false,
    'no fixed-length truncation of strip contents');
  assert.equal(save.includes('substring'), false, 'no substring truncation in the cache writer');
});
