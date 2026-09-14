import test from 'node:test';
import assert from 'node:assert/strict';
import { runLogSlice, historyFacts } from '../src/history-run-evidence.js';
import { terminalPresentation } from '../public/js/campaign-terminal.mjs';
const lines = [
  '[2026-09-09T13:13:44.728Z] === Campaign starting ===',
  '[2026-09-09T13:13:50.496Z] Pre-filter → 2 to process, 0 skipped',
  '[2026-09-09T13:17:11.120Z] A: 429',
  '[2026-09-09T13:17:38.411Z] === Campaign ended ===',
  '[2026-09-09T13:17:39.915Z] === Campaign starting ===',
  '[2026-09-09T13:17:44.940Z] Pre-filter → 2 to process, 0 skipped',
  '[2026-09-09T13:18:09.667Z] B: session expired',
  '[2026-09-09T13:18:17.485Z] === Campaign ended ===',
];
test('back-to-back legacy queue runs do not borrow each other’s logs', () => {
  assert.deepEqual(runLogSlice(lines, { date: '2026-09-09T13:17:36.794Z', duration: 234 }), lines.slice(0, 4));
  assert.deepEqual(runLogSlice(lines, { date: '2026-09-09T13:18:14.819Z', duration: 36 }), lines.slice(4));
});
test('recorded failures and unavailable accounts are not successful completions', () => {
  const blocked = historyFacts({ endReason: 'completed', debrief: { endNotice: { reason: 'all_parked', detail: 'Needs login' } } }, lines);
  assert.equal(blocked.totalTargets, 2); assert.equal(blocked.endReason, 'blocked');
  assert.equal(terminalPresentation(blocked).complete, false);
  const uncertain = historyFacts({ endReason: 'completed', errorCount: 1 }, lines);
  assert.equal(uncertain.endReason, 'needs_review');
  assert.equal(terminalPresentation(uncertain).complete, false);
});
test('unknown totals are not inferred from processed counts', () => {
  assert.equal(historyFacts({ totalProcessed: 0 }).totalTargets, null);
  assert.equal(terminalPresentation({ totalKnown: false }).complete, false);
});

test('operator Stop and fatal error remain authoritative over a stale end notice', () => {
  assert.match(terminalPresentation({ endReason: 'stopped', needsOutcomeReview: true, endNotice: { reason: 'no_more_rows' } }).label, /Stopped/);
  assert.equal(terminalPresentation({ endReason: 'errored', endNotice: { reason: 'no_more_rows' } }).label, 'Failed');
});
