import { test } from 'node:test';
import assert from 'node:assert';
import { recomputeNextCheckAt } from '../src/monitoring-time.js';

test('recomputeNextCheckAt honors 60-min cadence', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now, 60);
  assert.equal(next.toISOString(), '2026-05-15T21:00:00.000Z');
});

test('recomputeNextCheckAt honors 15-min cadence', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:07:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now, 15);
  assert.equal(next.toISOString(), '2026-05-15T20:15:00.000Z');
});

test('recomputeNextCheckAt defaults to 360 min (6h) when cadence omitted', () => {
  const sendingEndedAt = new Date('2026-05-15T20:00:00.000Z');
  const now = new Date('2026-05-15T20:00:00.000Z');
  const next = recomputeNextCheckAt(sendingEndedAt, now);
  assert.equal(next.toISOString(), '2026-05-16T02:00:00.000Z');
});
