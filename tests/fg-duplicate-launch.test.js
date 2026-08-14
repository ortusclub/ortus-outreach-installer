// The duplicate-launch guard. Sam dispatched the same 89 leads three times on
// 8 Aug (20:16 / 20:17 / 20:20, same page, same accounts); the second and third
// sent 1 and 0 invites because the first had already spent the accounts'
// monthly credits. This is the check that would have refused them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duplicateFgRun } from '../src/connections/fg-cloud-launch.js';

const SHEET = 'https://docs.google.com/spreadsheets/d/abc/edit?gid=42#gid=42';
const at = (iso) => Date.parse(iso);
const NOW = at('2026-08-08T20:20:34.000Z');
const runs = [
  { cloudId: 'cmp_first', pageId: 'apex', sheetUrl: SHEET, tab: '', dispatchedAt: '2026-08-08T20:16:42.000Z' },
  { cloudId: 'cmp_second', pageId: 'apex', sheetUrl: SHEET, tab: '', dispatchedAt: '2026-08-08T20:17:37.000Z' },
];

test('a third press of the same page + same sheet is a duplicate', () => {
  const d = duplicateFgRun(runs, { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: NOW });
  assert.equal(d.cloudId, 'cmp_second', 'reports the MOST RECENT run, so the "N minutes ago" is right');
});

test('a different page on the same sheet is not a duplicate', () => {
  // Ortus and Apex invite to different company pages and draw on different
  // accounts' credits. Running both off one list is legitimate.
  assert.equal(duplicateFgRun(runs, { pageId: 'ortus', sheetUrl: SHEET, tab: '' }, { now: NOW }), null);
});

test('the same page on a different sheet is not a duplicate', () => {
  assert.equal(duplicateFgRun(runs, { pageId: 'apex', sheetUrl: SHEET + '&gid=99', tab: '' }, { now: NOW }), null);
});

test('legacy tab runs are matched on the tab, not the (empty) sheet url', () => {
  const tabRuns = [{ cloudId: 'cmp_tab', pageId: 'ortus', sheetUrl: '', tab: 'FG 2026-08-15', dispatchedAt: '2026-08-08T20:16:00.000Z' }];
  assert.equal(duplicateFgRun(tabRuns, { pageId: 'ortus', sheetUrl: '', tab: 'FG 2026-08-15' }, { now: NOW }).cloudId, 'cmp_tab');
  assert.equal(duplicateFgRun(tabRuns, { pageId: 'ortus', sheetUrl: '', tab: 'FG 2026-09-01' }, { now: NOW }), null);
});

test('outside the window it is a deliberate re-run, not a duplicate', () => {
  // Credits refill, a row gets fixed, someone re-runs an hour later. That is
  // the operator meaning it — the guard exists for the double-press only.
  const later = at('2026-08-08T21:30:00.000Z');
  assert.equal(duplicateFgRun(runs, { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: later }), null);
});

test('a run with no dispatchedAt never blocks a launch', () => {
  // Adopted engine records can arrive undated. Blocking on one would wedge FG
  // with no way to tell the operator when the "existing" run supposedly began.
  const undated = [{ cloudId: 'cmp_x', pageId: 'apex', sheetUrl: SHEET, tab: '' }];
  assert.equal(duplicateFgRun(undated, { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: NOW }), null);
});

test('a clock skewed into the future does not block', () => {
  const future = [{ cloudId: 'cmp_f', pageId: 'apex', sheetUrl: SHEET, tab: '', dispatchedAt: '2026-08-09T04:00:00.000Z' }];
  assert.equal(duplicateFgRun(future, { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: NOW }), null);
});

test('an empty or missing store is not a duplicate', () => {
  assert.equal(duplicateFgRun([], { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: NOW }), null);
  assert.equal(duplicateFgRun(null, { pageId: 'apex', sheetUrl: SHEET, tab: '' }, { now: NOW }), null);
});
