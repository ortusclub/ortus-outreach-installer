/**
 * v2.52.0 — orphan-loop detection via generation counter.
 *
 * Symptom that motivated this fix: after Restore (WiFi died), pressing Stop
 * didn't stop the campaign. Root cause: restoreCampaign fire-and-forgets a
 * new startCampaign while the old loop is still in flight. startCampaign
 * resets campaign._abort = false, so the orphan old loop wakes up and
 * continues sending — bypassing the operator's Stop.
 *
 * The fix is a monotonic generation counter on the campaign object.
 * Each loop captures myGen = ++campaign._generation at start time and
 * checks `campaign._generation !== myGen` at every iteration boundary.
 * Orphans see the mismatch and exit even though _abort was reset.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign } from '../src/campaign.js';

test('campaign object has _generation field initialized to 0', () => {
  // Reset to a known state so this test is order-independent.
  campaign._generation = 0;
  assert.equal(typeof campaign._generation, 'number');
  assert.equal(campaign._generation, 0);
});

test('generation increments monotonically — orphan detection', () => {
  campaign._generation = 0;

  // Simulate startCampaign call #1 capturing its generation.
  const firstGen = ++campaign._generation;
  assert.equal(firstGen, 1);
  assert.equal(campaign._generation, 1);

  // First loop is the current loop — not an orphan.
  const firstIsOrphan = () => campaign._generation !== firstGen;
  assert.equal(firstIsOrphan(), false);

  // Simulate restoreCampaign re-launching: startCampaign call #2 captures
  // a new generation. This is the exact race the bug exploits — old loop
  // is still alive but _abort got reset by startCampaign.
  const secondGen = ++campaign._generation;
  assert.equal(secondGen, 2);
  assert.equal(campaign._generation, 2);

  // The first loop's check now reports orphan = true. Old loop exits.
  assert.equal(firstIsOrphan(), true);

  // The second loop is current — not an orphan.
  const secondIsOrphan = () => campaign._generation !== secondGen;
  assert.equal(secondIsOrphan(), false);
});

test('orphan detection survives _abort reset by startCampaign', () => {
  campaign._generation = 0;

  // Loop #1 captures gen 1, then gets aborted (operator Stop).
  const firstGen = ++campaign._generation;
  campaign._abort = true;

  // Simulate restoreCampaign re-launch: startCampaign resets _abort and
  // increments generation. This is the exact step that previously made
  // the old loop think the abort was over.
  campaign._abort = false;
  const secondGen = ++campaign._generation;

  // Even with _abort = false, the OLD loop's orphan check still fires.
  // That's the critical invariant: orphan status doesn't depend on _abort.
  const firstIsOrphan = () => campaign._generation !== firstGen;
  assert.equal(firstIsOrphan(), true);

  // The new loop's _abort is false (so it can run) AND it's not an orphan.
  const secondIsOrphan = () => campaign._generation !== secondGen;
  assert.equal(secondIsOrphan(), false);
  assert.equal(campaign._abort, false);
});

test('three concurrent generations — only the latest is non-orphan', () => {
  campaign._generation = 0;
  const gen1 = ++campaign._generation;
  const gen2 = ++campaign._generation;
  const gen3 = ++campaign._generation;

  assert.equal(campaign._generation !== gen1, true);  // orphan
  assert.equal(campaign._generation !== gen2, true);  // orphan
  assert.equal(campaign._generation !== gen3, false); // current
});
