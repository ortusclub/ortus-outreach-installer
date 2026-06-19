import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnectFailure, degradationBackoffMs } from '../src/campaign.js';

test('classifyConnectFailure routes real log strings', () => {
  assert.equal(classifyConnectFailure('VOYAGER_REJECTED: HTTP 429 — HTTP 429'), 'throttle');
  assert.equal(classifyConnectFailure('Page error: rate_limited'), 'throttle');
  assert.equal(classifyConnectFailure('WEEKLY_LIMIT'), 'invite_cap');
  assert.equal(classifyConnectFailure("You’ve reached the weekly invitation limit"), 'invite_cap');
  assert.equal(classifyConnectFailure('Please verify you are a human / checkpoint'), 'challenge');
  assert.equal(classifyConnectFailure('No modal appeared and connection not sent'), 'transient');
  assert.equal(classifyConnectFailure('Execution context was destroyed, most likely because of a navigation.'), 'transient');
  assert.equal(classifyConnectFailure('Already connected'), 'benign');
  assert.equal(classifyConnectFailure(''), 'benign');
});

test('degradationBackoffMs with jitter stays within [0, capped] and grows with streak', () => {
  const base = 1000, opts = { jitter: true, rng: () => 1 }; // rng=1 → max end of jitter
  assert.equal(degradationBackoffMs(base, 0, opts), base);          // streak 0 unchanged
  const s3 = degradationBackoffMs(base, 3, opts);
  assert.ok(s3 <= 1000 * 32 && s3 > 0);
  // rng=0 → bottom of the jitter window
  assert.equal(degradationBackoffMs(base, 3, { jitter: true, rng: () => 0 }), 0);
});
