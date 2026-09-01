// When this Mac stops hearing from the VM, the card must stop speaking in the
// present tense.
//
// Measured 2026-08-28: the tunnel to the engine died at 01:27 and at 09:11 the
// campaign card still read "MONITORING IS ACTIVE · until next automatic check:
// NOW · next check 02:08". All seven-and-a-half hours old. The engine had swept
// normally at 03:10, 05:10 and 07:10, so the only thing frozen was the app's
// picture of it — and the operator, reasonably, read the card as a broken VM.
//
// The card may report what the VM last said. It may never assert that it is
// still true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkIsLost, LOST_LINK_AFTER_S } from '../public/js/live-activity.mjs';

test('a fresh poll is not a lost link', () => {
  assert.equal(linkIsLost(0), false);
  assert.equal(linkIsLost(5), false);
});

test('one slow answer or a pod rollout does not trip it', () => {
  // The cloud detail polls every 5s. A rollout or a preempted API pod can eat a
  // handful of them; that is a wobble, not a silence.
  assert.equal(linkIsLost(30), false);
  assert.equal(linkIsLost(LOST_LINK_AFTER_S), false);
});

test('a real silence trips it', () => {
  assert.equal(linkIsLost(LOST_LINK_AFTER_S + 1), true);
  assert.equal(linkIsLost(27852), true);   // the measured overnight case
});

test('a campaign handed to this Mac never counts as a lost link', () => {
  // Its checks run HERE, so pollStatus owns the card and the cloud poll stands
  // down on purpose. Reading that deliberate silence as an outage would put
  // "cannot see the campaign" over a browser open on screen.
  assert.equal(linkIsLost(27852, true), false);
});

test('a missing or unreadable age never trips it', () => {
  // Fail towards the normal card: an unknown age is not evidence of silence.
  assert.equal(linkIsLost(undefined), false);
  assert.equal(linkIsLost(null), false);
  assert.equal(linkIsLost(NaN), false);
});
