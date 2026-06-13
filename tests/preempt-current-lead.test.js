import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preemptCurrentLead } from '../src/campaign.js';

// v2.97 — solo-check preempt. Between leads (and when no campaign is running),
// no lead race is armed, so preemptCurrentLead() is a safe no-op that reports
// nothing was interrupted. The "interrupts the in-flight lead" path is exercised
// by the live campaign loop (browser-driven) and verified manually.

test('preemptCurrentLead is a no-op when no lead is in flight', () => {
  assert.equal(preemptCurrentLead(), false);
});

test('preemptCurrentLead stays a no-op on repeated calls', () => {
  assert.equal(preemptCurrentLead(), false);
  assert.equal(preemptCurrentLead(), false);
});
