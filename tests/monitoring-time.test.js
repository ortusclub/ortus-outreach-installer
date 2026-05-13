import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMonitoringUntil, recomputeNextCheckAt, MONITORING_WINDOW_MS, CHECK_INTERVAL_MS } from '../src/monitoring-time.js';

const ISO = (s) => new Date(s);

test('computeMonitoringUntil returns sendingEndedAt + 7 days exactly', () => {
  const sent = ISO('2026-05-13T01:31:45.000Z');
  const until = computeMonitoringUntil(sent);
  assert.equal(until.toISOString(), '2026-05-20T01:31:45.000Z');
});

test('MONITORING_WINDOW_MS is exactly 7 days', () => {
  assert.equal(MONITORING_WINDOW_MS, 7 * 24 * 60 * 60 * 1000);
});

test('CHECK_INTERVAL_MS is exactly 6 hours', () => {
  assert.equal(CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test('recomputeNextCheckAt returns the next 6h boundary >= now', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, ISO('2026-05-13T05:00:00.000Z')).toISOString(), '2026-05-13T07:00:00.000Z');
});

test('recomputeNextCheckAt skips past multiple intervals if now is far ahead', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, ISO('2026-05-14T02:00:00.000Z')).toISOString(), '2026-05-14T07:00:00.000Z');
});

test('recomputeNextCheckAt returns sendingEndedAt + 6h when now == sendingEndedAt', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, sent).toISOString(), '2026-05-13T07:00:00.000Z');
});

test('recomputeNextCheckAt: exactly on a boundary returns the NEXT boundary (strict > not >=)', () => {
  const sent = ISO('2026-05-13T01:00:00.000Z');
  const exactBoundary = ISO('2026-05-13T07:00:00.000Z');
  assert.equal(recomputeNextCheckAt(sent, exactBoundary).toISOString(), '2026-05-13T13:00:00.000Z');
});

test('recomputeNextCheckAt accepts both Date and ISO-string inputs', () => {
  const r = recomputeNextCheckAt('2026-05-13T01:00:00.000Z', '2026-05-13T05:00:00.000Z');
  assert.equal(r.toISOString(), '2026-05-13T07:00:00.000Z');
});
