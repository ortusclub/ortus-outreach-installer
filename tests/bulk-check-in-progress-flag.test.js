import { test } from 'node:test';
import assert from 'node:assert';
import { setBulkCheckInProgress, getCampaignStatus } from '../src/campaign.js';

// The dashboard's monitoring hero flips to the gold pulsing "CHECKING / now"
// when status.monitoringCheckInProgress is true. The scheduled auto-check
// (tickMonitoringNow) already sets the underlying flag; this setter lets the
// MANUAL /api/bulk-check-now sweep report the same state so the two paths
// can't drift (and so a manual + scheduled sweep can't collide).

test('setBulkCheckInProgress(true) surfaces monitoringCheckInProgress=true in status', () => {
  setBulkCheckInProgress(true);
  assert.equal(getCampaignStatus().monitoringCheckInProgress, true);
  setBulkCheckInProgress(false); // cleanup
});

test('setBulkCheckInProgress(false) clears the flag', () => {
  setBulkCheckInProgress(true);
  setBulkCheckInProgress(false);
  assert.equal(getCampaignStatus().monitoringCheckInProgress, false);
});

test('setBulkCheckInProgress coerces to a real boolean', () => {
  setBulkCheckInProgress(1);
  assert.equal(getCampaignStatus().monitoringCheckInProgress, true);
  setBulkCheckInProgress(0);
  assert.equal(getCampaignStatus().monitoringCheckInProgress, false);
});
