import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { jobIdsForCampaign, scopeLiveLines } from '../src/scrape-log-scope.js';

// Measured on the live board 2026-08-13: three different campaigns' log
// endpoints returned byte-identical sets of 117 lines belonging to 21 jobs that
// were none of theirs. `Results 22` displayed "stopped on error" and "this
// LinkedIn account is logged out" from a batch of failed "Results 1111 N" runs
// while it was collecting normally, and went on to finish 1,270 leads.

// The real shape, trimmed: engine live-buffer lines all carry a jobId.
const LINES = [
  { ts: 1, message: 'Starting…', jobId: 'job-A', tabName: 'Results 22' },
  { ts: 2, message: 'logged out', jobId: 'job-B', tabName: 'Results 1111 7' },
  { ts: 3, message: '→ 700 leads', jobId: 'job-A', tabName: 'Results 22' },
  { ts: 4, message: 'logged out', jobId: 'job-C', tabName: 'Results 1111 8' },
];

test("a campaign gets its own job's lines and nobody else's", () => {
  const ids = jobIdsForCampaign({ jobs: [{ id: 'job-A', runId: 'job-A' }] });
  const got = scopeLiveLines(LINES, ids);
  assert.deepEqual(got.map((l) => l.message), ['Starting…', '→ 700 leads']);
});

test('a shared tab name no longer drags in other scrapes', () => {
  // Every line below is on a tab starting with "Results" — the old prefix rule
  // matched all of them. Job identity keeps them apart.
  const ids = jobIdsForCampaign({ jobs: [{ id: 'job-B' }] });
  const got = scopeLiveLines(LINES, ids);
  assert.deepEqual(got.map((l) => l.jobId), ['job-B']);
  assert.equal(got.some((l) => l.tabName === 'Results 22'), false);
});

test('an unidentifiable campaign gets NOTHING, not everything', () => {
  // The old guard was `!tabName || …`, so an empty key made the filter a no-op
  // and returned the whole global buffer. Every engine-derived strip hit that
  // path, because those have no local record to take a tab name from.
  assert.deepEqual(scopeLiveLines(LINES, jobIdsForCampaign(null)), []);
  assert.deepEqual(scopeLiveLines(LINES, jobIdsForCampaign({ jobs: [] })), []);
  assert.deepEqual(scopeLiveLines(LINES, new Set()), []);
});

test('an unlabelled line is dropped rather than shown to everyone', () => {
  const ids = jobIdsForCampaign({ jobs: [{ id: 'job-A' }] });
  const got = scopeLiveLines([{ ts: 9, message: 'orphan' }, ...LINES], ids);
  assert.equal(got.some((l) => l.message === 'orphan'), false);
});

test('both id and runId identify a job', () => {
  // They are the same value today. Collecting both means a future split cannot
  // silently empty the set — which would blank every log, not just mis-scope it.
  const ids = jobIdsForCampaign({ jobs: [{ id: 'x', runId: 'y' }, { runId: 'z' }] });
  assert.deepEqual([...ids].sort(), ['x', 'y', 'z']);
});

test('malformed input never throws into the log route', () => {
  assert.deepEqual(jobIdsForCampaign(undefined), new Set());
  assert.deepEqual(jobIdsForCampaign({ jobs: [null, {}] }), new Set());
  assert.deepEqual(scopeLiveLines(null, new Set(['a'])), []);
  assert.deepEqual(scopeLiveLines([null, undefined], new Set(['a'])), []);
});

// ── Board rendering (source assertions; app.js is a browser bundle) ──────────
// The strobe: `host.innerHTML = html` ran every 2.5s, destroying all ~290 strips
// and, with them, the live log element inside any expanded strip. The fresh one
// was empty, `.vj-log:empty::after` printed "No events yet", and the content
// only returned when an async refetch landed. Frame-differencing the screen
// recording showed a blank frame and a refill frame 0.30–0.42s apart, once per
// poll cycle.

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('the board is patched, never wholesale-replaced', () => {
  assert.match(APP, /_snPatchBoard\(host, html\);/);
  assert.equal(/host\.innerHTML = html;/.test(APP), false, 'the full rebuild must not come back');
});

test('an unchanged strip is left completely untouched', () => {
  // This is what stops 279 finished strips being rebuilt every 2.5s.
  assert.match(APP, /if \(prev\.dataset\.sig === el\.dataset\.sig\) \{ wanted\.push\(prev\); continue; \}/);
});

test('a changed strip keeps its live log node', () => {
  // Without this, every RUNNING strip still blanks once per poll — the exact
  // case in the recording.
  assert.match(APP, /_snCarryLiveNodes\(prev, el\);/);
  assert.match(APP, /nb\.replaceWith\(ob\);/);
  assert.match(APP, /ob\.scrollTop = top;/);
});

test('the signature is hashed from the rendered markup, not a hand-listed set', () => {
  // A hand-listed set of fields goes stale the moment someone adds a field to
  // the template, and a stale signature freezes a strip on old values.
  assert.match(APP, /return _html\.replace\('__SIG__', _snHash\(_html\)\);/);
});

test('a one-search scrape never shows a permanent 0%', () => {
  // It used to sit on "0% · 0 of 1 searches done" through 1,270 leads because
  // the percentage counted only FINISHED searches, and the honest answer then
  // was an indeterminate bar. The engine now reports each job's page ceiling,
  // so the bar moves per page and indeterminate is reserved for a scrape with
  // genuinely nothing to measure (no ceiling, LinkedIn gave no total).
  assert.match(APP, /const units = scrapeProgressUnits\(jobs\);/);
  assert.match(APP, /const indeterminate = c\.status === 'running' && units === 0 && total <= 1 && done === 0;/);
  assert.match(APP, /setF\('activePct', indeterminate \? '—' : pct\);/);
});

test('expanding a Sales Nav strip renders its OWN board immediately', () => {
  // The handler called renderCampaignsBoard() — the campaigns board — so a
  // scrape's rich card and live log were only built by the next 2.5s poll, and
  // never while a poll was slow or stalled. The strip opened to an empty shell.
  assert.match(APP, /if \(strip\.closest\('#sn-board'\)\) \{/);
  assert.match(APP, /if \(_snLastCampaigns\) renderSalesNavBoard\(_snLastCampaigns\);/);
});

test('the board poll timer is installed before the first fetch, not after it', () => {
  // /api/jobs takes 5-10s warm and was measured at 83s during app boot. Awaiting
  // it before setInterval left the board with no poll timer for that whole
  // window — frozen strips, no re-render, nothing to open.
  const open = APP.slice(APP.indexOf('async function openSalesNavBoard'), APP.indexOf('window.openSalesNavBoard'));
  const setIdx = open.indexOf('setInterval(pollSalesNavBoard, 2500)');
  assert.ok(setIdx > -1, 'the poll interval must still be installed');
  assert.equal(/await pollSalesNavBoard\(\);/.test(open), false, 'the first poll must not gate the timer');
  assert.equal(/await loadOperatorEmail\(\);/.test(open), false, 'the email fetch must not gate the timer either');
});

test('one hung request cannot freeze the board for the rest of the session', () => {
  // _snPollInFlight is set before the fetch and cleared in `finally`. A fetch
  // that neither resolves nor rejects therefore left it true forever: every
  // later tick returned early, so the board stopped polling and stopped
  // re-rendering until the app was restarted. Observed live 2026-08-13 — a
  // direct openSalesNavBoard() call issued no request at all.
  assert.match(APP, /const SN_POLL_TIMEOUT_MS = 30000;/);
  assert.match(APP, /const SN_POLL_STUCK_MS = 60000;/);
  // Defence 1: the fetch always settles, so `finally` always runs.
  assert.match(APP, /fetch\('\/api\/scrape\/campaigns', \{ signal: AbortSignal\.timeout\(SN_POLL_TIMEOUT_MS\) \}\)/);
  // Defence 2: a stale in-flight mark is overridden rather than trusted.
  assert.match(APP, /if \(_snPollInFlight && Date\.now\(\) - _snPollStartedAt < SN_POLL_STUCK_MS\) return;/);
  assert.match(APP, /_snPollStartedAt = Date\.now\(\);/);
});
