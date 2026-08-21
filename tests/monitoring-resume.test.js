import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResumeAction } from '../src/monitoring-resume.js';

const FIXED_NOW = new Date('2026-05-15T10:00:00Z');

test('decideResumeAction: state=monitoring + window not expired → "resume" (default 60min cadence)', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-13T01:00:00Z', monitoringUntil: '2026-05-20T01:00:00Z', nextCheckAt: '2026-05-15T07:00:00Z' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
  // Without checkIntervalMinutes set, falls back to 60-min cadence.
  // 57h elapsed since sendingEndedAt → next 1h boundary > now = 11:00.
  assert.equal(r.recomputedNextCheckAt.toISOString(), '2026-05-15T11:00:00.000Z');
});

test('decideResumeAction: honours checkIntervalMinutes for 6h cadence', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-13T01:00:00Z', monitoringUntil: '2026-05-20T01:00:00Z', nextCheckAt: '2026-05-15T07:00:00Z', checkIntervalMinutes: 360 };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
  // 57h elapsed → next 6h boundary > now = 13:00.
  assert.equal(r.recomputedNextCheckAt.toISOString(), '2026-05-15T13:00:00.000Z');
});

test('decideResumeAction: honours checkIntervalMinutes for 15min cadence (regression test)', () => {
  // v2.14.x regression — pre-fix, this resolved to a 6h boundary because
  // decideResumeAction omitted cadenceMin when calling recomputeNextCheckAt.
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-15T09:30:00Z', monitoringUntil: '2026-05-22T09:30:00Z', nextCheckAt: '2026-05-15T09:45:00Z', checkIntervalMinutes: 15 };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
  // 30min elapsed since sendingEndedAt → next 15min boundary > 10:00 = 10:15.
  assert.equal(r.recomputedNextCheckAt.toISOString(), '2026-05-15T10:15:00.000Z');
});

// Review finding 3: the streak survives a restart but pre-fix decideResumeAction
// ignored it, snapping a quiet campaign back to hourly on every boot/wake.
test('decideResumeAction: honours a restored emptyCheckStreak, not just the base cadence', () => {
  const c = {
    state: 'monitoring',
    sendingEndedAt: '2026-05-15T09:00:00Z',
    monitoringUntil: '2026-05-22T09:00:00Z',
    nextCheckAt: '2026-05-15T10:00:00Z',
    checkIntervalMinutes: 60,
    emptyCheckStreak: 6, // >=6 → x4 → 240min cadence, not 60
  };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
  // 1h elapsed since sendingEndedAt → next 240min boundary > now = 13:00.
  assert.equal(r.recomputedNextCheckAt.toISOString(), '2026-05-15T13:00:00.000Z');
});

test('decideResumeAction: state=monitoring + monitoringUntil <= now → "expire"', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-01T01:00:00Z', monitoringUntil: '2026-05-08T01:00:00Z' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'expire');
});

test('decideResumeAction: state=done → "noop"', () => {
  const c = { state: 'done' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'noop');
});

test('decideResumeAction: state=running → "noop"', () => {
  const c = { state: 'running' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'noop');
});

test('decideResumeAction: null campaign → "noop"', () => {
  const r = decideResumeAction(null, FIXED_NOW);
  assert.equal(r.action, 'noop');
});

test('decideResumeAction: monitoringUntil exactly == now → "expire" (boundary inclusive)', () => {
  const t = '2026-05-15T10:00:00Z';
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-08T10:00:00Z', monitoringUntil: t };
  const r = decideResumeAction(c, t);
  assert.equal(r.action, 'expire');
});
