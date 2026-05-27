import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePillState, shouldShowConsole } from '../public/js/live-console.mjs';

test('module exports both helpers', () => {
  assert.equal(typeof computePillState, 'function');
  assert.equal(typeof shouldShowConsole, 'function');
});

// ── computePillState ────────────────────────────────────────────────────
const baseStatus = {
  running: true, paused: false, state: 'sending',
  name: 'Sam', mode: 'connect_and_introduce',
  currentProfile: 'Marlon',
  currentAction: { label: 'Sending intro DM', lead: 'Priya Sharma' },
  processedToday: 47, totalTargets: 280,
  errors: [], parked: [], logs: [], throttle: null,
};

test('computePillState: healthy running → green pulse, no segments', () => {
  const r = computePillState(baseStatus);
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.errSegment, null);
  assert.equal(r.parkedSegment, null);
  assert.equal(r.label, 'Sam · CC+IC');
  assert.equal(r.processed, 47);
  assert.equal(r.total, 280);
});

test('computePillState: throttle.active → amber, no pulse, surfaces reason', () => {
  const r = computePillState({ ...baseStatus, throttle: { active: true, reason: 'cpu-high', multiplier: 0.6 } });
  assert.equal(r.dot, 'amber');
  assert.equal(r.pulse, false);
  assert.equal(r.throttleReason, 'cpu-high');
});

test('computePillState: errors.length > 0 → green pulse + err segment', () => {
  const r = computePillState({ ...baseStatus, errors: [{ message: 'a' }, { message: 'b' }] });
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.errSegment, '· 2 err');
});

test('computePillState: parked.length > 0 → amber + parked segment', () => {
  const r = computePillState({ ...baseStatus, parked: [{ profileId: 'x' }] });
  assert.equal(r.dot, 'amber');
  assert.equal(r.pulse, false);
  assert.equal(r.parkedSegment, '· 1 parked');
});

test('computePillState: paused → gray, no pulse, label flips to paused', () => {
  const r = computePillState({ ...baseStatus, paused: true });
  assert.equal(r.dot, 'gray');
  assert.equal(r.pulse, false);
  assert.equal(r.label, 'Sam · paused');
});

test('computePillState: state=monitoring → green pulse, monitoring label', () => {
  const r = computePillState({ ...baseStatus, state: 'monitoring' });
  assert.equal(r.dot, 'green');
  assert.equal(r.pulse, true);
  assert.equal(r.label, 'Sam · monitoring');
});

test('computePillState: missing fields → graceful fallback', () => {
  const r = computePillState({ running: true });
  assert.equal(r.dot, 'gray');
  assert.equal(r.name, '—');
  assert.equal(r.processed, 0);
  assert.equal(r.total, 0);
});

test('computePillState: precedence — paused beats throttle', () => {
  const r = computePillState({ ...baseStatus, paused: true, throttle: { active: true, reason: 'x' } });
  assert.equal(r.dot, 'gray');
});
