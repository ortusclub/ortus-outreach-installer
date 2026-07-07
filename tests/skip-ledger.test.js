import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  recordSkip, getSkips, clearSkips,
  ALREADY_PROCESSED, IDENTITY_UNCONFIRMED, WATCHDOG_TIMEOUT,
  MALFORMED_URL, DUPLICATE_ROW, FAILED_REPEATEDLY, TERMINAL_STAGE, OTHER,
} from '../src/skip-ledger.js';

beforeEach(() => clearSkips());

test('recordSkip adds entry with timestamp', () => {
  const before = Date.now();
  recordSkip({ url: 'https://linkedin.com/in/foo', leadName: 'Foo Bar', reason: ALREADY_PROCESSED });
  const after = Date.now();
  const skips = getSkips();
  assert.equal(skips.length, 1);
  const entry = skips[0];
  assert.equal(entry.url, 'https://linkedin.com/in/foo');
  assert.equal(entry.leadName, 'Foo Bar');
  assert.equal(entry.reason, ALREADY_PROCESSED);
  assert.ok(entry.timestamp, 'timestamp should be set');
  const ts = new Date(entry.timestamp).getTime();
  assert.ok(ts >= before && ts <= after, 'timestamp should be within call window');
});

test('getSkips returns a copy — mutation does not affect ledger', () => {
  recordSkip({ url: 'https://linkedin.com/in/a', leadName: 'A', reason: OTHER });
  const copy = getSkips();
  copy.push({ fake: true });
  assert.equal(getSkips().length, 1, 'ledger should still have 1 entry');
});

test('clearSkips empties the ledger', () => {
  recordSkip({ url: 'https://linkedin.com/in/b', leadName: 'B', reason: OTHER });
  clearSkips();
  assert.equal(getSkips().length, 0);
});

test('recordSkip with missing optional fields does not throw', () => {
  assert.doesNotThrow(() =>
    recordSkip({ url: 'https://linkedin.com/in/c', leadName: 'C', reason: MALFORMED_URL })
  );
  const entry = getSkips()[0];
  assert.equal(entry.rowNumber, undefined);
  assert.equal(entry.profileId, undefined);
  assert.equal(entry.profileName, undefined);
  assert.equal(entry.detail, undefined);
});

test('multiple recordSkip calls accumulate entries', () => {
  recordSkip({ url: 'https://linkedin.com/in/x', leadName: 'X', reason: DUPLICATE_ROW });
  recordSkip({ url: 'https://linkedin.com/in/y', leadName: 'Y', reason: FAILED_REPEATEDLY });
  assert.equal(getSkips().length, 2);
});

test('all reason constants are non-empty strings', () => {
  const constants = [
    ALREADY_PROCESSED, IDENTITY_UNCONFIRMED, WATCHDOG_TIMEOUT,
    MALFORMED_URL, DUPLICATE_ROW, FAILED_REPEATEDLY, TERMINAL_STAGE, OTHER,
  ];
  for (const c of constants) {
    assert.equal(typeof c, 'string');
    assert.ok(c.length > 0, `constant should not be empty: ${c}`);
  }
});

test('reason constants have expected values', () => {
  assert.equal(ALREADY_PROCESSED,   'already_processed');
  assert.equal(IDENTITY_UNCONFIRMED, 'identity_unconfirmed');
  assert.equal(WATCHDOG_TIMEOUT,     'watchdog_timeout');
  assert.equal(MALFORMED_URL,        'malformed_url');
  assert.equal(DUPLICATE_ROW,        'duplicate_row');
  assert.equal(FAILED_REPEATEDLY,    'failed_repeatedly');
  assert.equal(TERMINAL_STAGE,       'terminal_stage');
  assert.equal(OTHER,                'other');
});
