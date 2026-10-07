// The scrape UI shows an amber "possibly throttled" line when the engine marks a
// search job.throttleSuspected. These pin the two display helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isSearchThrottled, scrapeThrottleReason } from '../public/js/scrape-board.mjs';

test('isSearchThrottled is true only when the engine flagged the job', () => {
  assert.equal(isSearchThrottled({ throttleSuspected: true }), true);
  assert.equal(isSearchThrottled({ throttleSuspected: false }), false);
  assert.equal(isSearchThrottled({}), false);
  assert.equal(isSearchThrottled(null), false);
  assert.equal(isSearchThrottled(undefined), false);
});

test('scrapeThrottleReason surfaces the engine reason when present', () => {
  const reason = 'the search showed ~983 results but only 0 leads came back — rest it.';
  assert.equal(scrapeThrottleReason({ throttleSuspected: true, throttleReason: reason }), reason);
});

test('scrapeThrottleReason falls back to a plain message when none is given', () => {
  assert.match(scrapeThrottleReason({ throttleSuspected: true }), /may be throttled/);
  assert.match(scrapeThrottleReason(null), /may be throttled/);
});
