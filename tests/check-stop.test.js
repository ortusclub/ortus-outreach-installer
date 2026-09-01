import { test } from 'node:test';
import assert from 'node:assert';
// The in-flight flag setter is named setBulkCheckInProgress in campaign.js
// (there is no setCheckInProgress); it drives the same _checkInProgress that
// stopMonitoringCheck reads.
import { campaign, stopMonitoringCheck, setBulkCheckInProgress, getCampaignStatus } from '../src/campaign.js';

test('stopping when no check is running is a no-op', () => {
  setBulkCheckInProgress(false);
  campaign._abortCheck = false;
  const r = stopMonitoringCheck();
  assert.equal(r.ok, true);
  assert.equal(r.wasRunning, false);
  assert.equal(campaign._abortCheck, false, 'must not arm the flag with nothing to stop');
});

test('stopping a running check arms the flag and reports the interrupted person', () => {
  setBulkCheckInProgress(true);
  campaign._abortCheck = false;
  campaign._checkingLead = 'Rina Chandran';
  const r = stopMonitoringCheck();
  assert.equal(r.ok, true);
  assert.equal(r.wasRunning, true);
  assert.equal(r.interrupted, 'Rina Chandran');
  assert.equal(campaign._abortCheck, true);
});

test('stopping a check does NOT stop the campaign', () => {
  // The whole reason _abortCheck exists rather than reusing _abort.
  setBulkCheckInProgress(true);
  campaign.state = 'monitoring';
  campaign._abort = false;
  campaign.nextCheckAt = '2026-08-21T12:00:00.000Z';
  stopMonitoringCheck();
  assert.equal(campaign._abort, false, 'the campaign-wide abort must stay untouched');
  assert.equal(campaign.state, 'monitoring', 'monitoring must survive a stopped check');
  assert.equal(campaign.nextCheckAt, '2026-08-21T12:00:00.000Z', 'the cadence must be unchanged');
});

test('the status payload reports a stopping check', () => {
  setBulkCheckInProgress(true);
  campaign._abortCheck = true;
  assert.equal(getCampaignStatus().checkStopping, true);
  campaign._abortCheck = false;
  assert.equal(getCampaignStatus().checkStopping, false);
});

test('clearing the in-flight flag disarms the stop for the next check', () => {
  setBulkCheckInProgress(true);
  campaign._abortCheck = true;
  setBulkCheckInProgress(false);
  assert.equal(campaign._abortCheck, false, 'a new check must never start already stopped');
  assert.equal(campaign._checkingLead, null);
});
