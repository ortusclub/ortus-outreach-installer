// A campaign that runs out of rows has to say WHY.
//
// Field report 2026-08-03: the live log read "Pre-filter → 431 to process, 0
// skipped", sent one lead, then "All leads processed or filtered out." The 430
// rows dropped in between were all recorded via recordSkip — but the ledger is
// in-memory and never printed, so the operator spent four days rebuilding the
// sheet against a filter that was reading local state, not the sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeSkips, ALREADY_PROCESSED, MALFORMED_URL, TERMINAL_STAGE,
} from '../src/skip-ledger.js';

const skip = (reason, n) => Array.from({ length: n }, () => ({ reason }));

test('nothing skipped → empty string, so callers can append blind', () => {
  assert.equal(summarizeSkips([]), '');
  assert.equal(summarizeSkips(null), '');
  assert.equal(summarizeSkips(undefined), '');
});

test('names the reason that actually cost the operator the run', () => {
  const out = summarizeSkips(skip(ALREADY_PROCESSED, 430));
  assert.match(out, /430 row\(s\) skipped/);
  assert.match(out, /430 already actioned by this app/);
});

test('leads with a space so it appends cleanly to the exhaustion line', () => {
  assert.match(summarizeSkips(skip(MALFORMED_URL, 1)), /^ /);
});

test('mixed reasons are ordered by count, biggest first', () => {
  const out = summarizeSkips([
    ...skip(MALFORMED_URL, 2),
    ...skip(ALREADY_PROCESSED, 50),
    ...skip(TERMINAL_STAGE, 7),
  ]);
  assert.equal(out, ' 59 row(s) skipped: 50 already actioned by this app, 7 already marked done in the sheet, 2 no usable LinkedIn URL.');
});

test('an unknown reason shows its slug rather than vanishing', () => {
  // Dropping it would under-report the total and hide a real cause.
  const out = summarizeSkips([{ reason: 'some_future_reason' }]);
  assert.match(out, /1 row\(s\) skipped: 1 some_future_reason\./);
});

test('a missing reason still counts toward the total', () => {
  const out = summarizeSkips([{}, {}]);
  assert.match(out, /2 row\(s\) skipped/);
});
