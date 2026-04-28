import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure logic — pushSoftWarning helper. Replicated here to avoid coupling
// the test to campaign.js internals (matches the pattern of
// tests/watchdog-helper.test.js which inlines withWatchdog).

const SOFT_WARNING_DEDUPE_MS = 10 * 60 * 1000;
const SOFT_WARNING_CAP = 200;

function pushSoftWarning(state, { profileId, pName, kind, message }) {
  const now = Date.now();
  const cutoff = now - SOFT_WARNING_DEDUPE_MS;
  for (let i = state.softWarnings.length - 1; i >= 0; i--) {
    const e = state.softWarnings[i];
    if (e.detectedAt < cutoff) break;
    if (e.profileId === profileId && e.kind === kind) return null;
  }
  const entry = { profileId, pName, kind, message, detectedAt: now };
  state.softWarnings.push(entry);
  while (state.softWarnings.length > SOFT_WARNING_CAP) state.softWarnings.shift();
  return entry;
}

test('pushSoftWarning adds entry to empty state', () => {
  const state = { softWarnings: [] };
  const result = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'rate_limited', message: 'test',
  });
  assert.equal(state.softWarnings.length, 1);
  assert.equal(state.softWarnings[0].profileId, 'p1');
  assert.equal(state.softWarnings[0].kind, 'rate_limited');
  assert.equal(state.softWarnings[0].message, 'test');
  assert.equal(typeof state.softWarnings[0].detectedAt, 'number');
  assert.equal(result, state.softWarnings[0]);
});

test('pushSoftWarning dedupes same (profileId, kind) within window', () => {
  const state = { softWarnings: [] };
  const first = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'first',
  });
  const second = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'second',
  });
  assert.ok(first);
  assert.equal(second, null);
  assert.equal(state.softWarnings.length, 1);
  assert.equal(state.softWarnings[0].message, 'first');
});

test('pushSoftWarning allows different kind for same profile within window', () => {
  const state = { softWarnings: [] };
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'limit',
  });
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'rate_limited', message: 'rate',
  });
  assert.equal(state.softWarnings.length, 2);
});

test('pushSoftWarning allows same kind for different profile within window', () => {
  const state = { softWarnings: [] };
  pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'a',
  });
  pushSoftWarning(state, {
    profileId: 'p2', pName: 'Beth', kind: 'weekly_limit', message: 'b',
  });
  assert.equal(state.softWarnings.length, 2);
});

test('pushSoftWarning re-allows same (profileId, kind) after window expires', () => {
  const state = { softWarnings: [] };
  // Manually seed an expired entry
  state.softWarnings.push({
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'old',
    detectedAt: Date.now() - (SOFT_WARNING_DEDUPE_MS + 1000),
  });
  const result = pushSoftWarning(state, {
    profileId: 'p1', pName: 'Adam', kind: 'weekly_limit', message: 'new',
  });
  assert.ok(result);
  assert.equal(state.softWarnings.length, 2);
  assert.equal(state.softWarnings[1].message, 'new');
});

test('pushSoftWarning trims from front when cap exceeded', () => {
  const state = { softWarnings: [] };
  // Push 201 entries with different (profileId, kind) so dedupe doesn't fire
  for (let i = 0; i < 201; i++) {
    pushSoftWarning(state, {
      profileId: `p${i}`, pName: `n${i}`, kind: 'rate_limited', message: `m${i}`,
    });
  }
  assert.equal(state.softWarnings.length, 200);
  // Oldest (p0) should be evicted; newest (p200) should be present
  assert.equal(state.softWarnings[0].profileId, 'p1');
  assert.equal(state.softWarnings[199].profileId, 'p200');
});
