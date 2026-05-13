import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideResumeAction } from '../src/monitoring-resume.js';

const FIXED_NOW = new Date('2026-05-15T10:00:00Z');

test('decideResumeAction: state=monitoring + window not expired → "resume"', () => {
  const c = { state: 'monitoring', sendingEndedAt: '2026-05-13T01:00:00Z', monitoringUntil: '2026-05-20T01:00:00Z', nextCheckAt: '2026-05-15T07:00:00Z' };
  const r = decideResumeAction(c, FIXED_NOW);
  assert.equal(r.action, 'resume');
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
