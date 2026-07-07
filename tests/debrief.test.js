// tests/debrief.test.js — unit tests for the pure debrief-snapshot builder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebrief, MAX_DEBRIEF_SKIPS, MAX_ERROR_SAMPLES } from '../src/debrief.js';

test('empty inputs → empty-but-well-formed snapshot', () => {
  const d = buildDebrief();
  assert.equal(d.skipTotal, 0);
  assert.deepEqual(d.skipReasons, {});
  assert.deepEqual(d.skips, []);
  assert.deepEqual(d.parked, []);
  assert.deepEqual(d.errors, { count: 0, samples: [] });
  assert.equal(d.endNotice, null);
});

test('skip reasons are tallied; rows carry through', () => {
  const skips = [
    { url: 'https://x/1', leadName: 'A', rowNumber: 2, profileName: 'P1', reason: 'malformed_url', detail: 'no URL', timestamp: 't1' },
    { url: 'https://x/2', leadName: 'B', reason: 'malformed_url' },
    { url: 'https://x/3', leadName: 'C', reason: 'identity_unconfirmed' },
    { url: 'https://x/4', leadName: 'D' }, // no reason → other
  ];
  const d = buildDebrief({ skips });
  assert.equal(d.skipTotal, 4);
  assert.deepEqual(d.skipReasons, { malformed_url: 2, identity_unconfirmed: 1, other: 1 });
  assert.equal(d.skips.length, 4);
  assert.deepEqual(d.skips[0], {
    url: 'https://x/1', leadName: 'A', rowNumber: 2, profileName: 'P1',
    reason: 'malformed_url', detail: 'no URL', timestamp: 't1',
  });
  // missing optionals normalized
  assert.equal(d.skips[1].rowNumber, null);
  assert.equal(d.skips[3].reason, 'other');
});

test('skips are capped at MAX_DEBRIEF_SKIPS but skipTotal keeps the real count', () => {
  const skips = Array.from({ length: MAX_DEBRIEF_SKIPS + 40 }, (_, i) => ({
    url: `u${i}`, leadName: `L${i}`, reason: 'terminal_stage',
  }));
  const d = buildDebrief({ skips });
  assert.equal(d.skips.length, MAX_DEBRIEF_SKIPS);
  assert.equal(d.skipTotal, MAX_DEBRIEF_SKIPS + 40);
  assert.equal(d.skipReasons.terminal_stage, MAX_DEBRIEF_SKIPS + 40);
});

test('parked accounts carry id/name/reason/parkedAt', () => {
  const parked = [
    { profileId: 'p1', pName: 'James', reason: 'weekly_limit_429', parkedAt: 1720000000000 },
    { pName: 'Marta', reason: 'session_expired' },
  ];
  const d = buildDebrief({ parked });
  assert.deepEqual(d.parked[0], { profileId: 'p1', pName: 'James', reason: 'weekly_limit_429', parkedAt: 1720000000000 });
  assert.deepEqual(d.parked[1], { profileId: '', pName: 'Marta', reason: 'session_expired', parkedAt: null });
});

test('errors: count is total, samples are the LAST N', () => {
  const errors = Array.from({ length: MAX_ERROR_SAMPLES + 3 }, (_, i) => ({ time: `t${i}`, message: `e${i}` }));
  const d = buildDebrief({ errors });
  assert.equal(d.errors.count, MAX_ERROR_SAMPLES + 3);
  assert.equal(d.errors.samples.length, MAX_ERROR_SAMPLES);
  assert.equal(d.errors.samples[0].message, 'e3'); // last 5 of 8
  assert.equal(d.errors.samples[MAX_ERROR_SAMPLES - 1].message, `e${MAX_ERROR_SAMPLES + 2}`);
});

test('endNotice is reduced to reason + detail only', () => {
  const d = buildDebrief({
    endNotice: { reason: 'all_parked', detail: 'James: weekly invite limit reached', processed: 12, ts: 1 },
  });
  assert.deepEqual(d.endNotice, { reason: 'all_parked', detail: 'James: weekly invite limit reached' });
});

test('snapshot is JSON-round-trippable (goes into history.json)', () => {
  const d = buildDebrief({
    skips: [{ url: 'u', leadName: 'L', reason: 'duplicate_row' }],
    parked: [{ profileId: 'p', pName: 'N', reason: 'challenge', parkedAt: 5 }],
    errors: [{ time: 1, message: 'boom' }],
    endNotice: { reason: 'error', detail: 'boom' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});
