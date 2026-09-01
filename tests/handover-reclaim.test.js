// Handing a check-only campaign BACK to the VM. Nothing is re-dispatched: the
// engine row survived the move (a monitoring campaign is never cancelled by
// handover-release), so it is taken back by id.
//
// ORTUS_DATA_DIR is redirected before campaign.js is imported so
// writeMonitoringState writes into a temp dir, never the repo's tracked
// data/monitoring-campaign.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimableCloudId, reclaimRefusal } from '../src/handover.js';

process.env.ORTUS_DATA_DIR = await mkdtemp(join(tmpdir(), 'ortus-reclaim-'));
const { adoptMonitoring, startCampaign, campaign, SINGLETON_CAMPAIGN_ID, getCampaignStatus, stopMonitoringWatcher, stopMonitoring } =
  await import('../src/campaign.js');

const adopt = () => adoptMonitoring({
  id: 'cloud-42',
  mode: 'connect_and_introduce',
  sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
  profileIds: ['p1'],
  profileNames: ['Anna'],
  participatingProfileIds: ['p1'],
  checkIntervalMinutes: 120,
});

test('an adopted campaign is reclaimable by its cloud id', async (t) => {
  t.after(() => stopMonitoringWatcher());
  await adopt();
  assert.equal(reclaimableCloudId(campaign, SINGLETON_CAMPAIGN_ID), 'cloud-42',
    'the reclaim path must be taken for a campaign this Mac adopted from the VM');
});

test('a locally started campaign has no engine row to reclaim', () => {
  // The singleton id is what every local run carries, and startCampaign restores
  // it, so an earlier adopt cannot leak its cloud id into a later local campaign.
  assert.equal(reclaimableCloudId({ id: SINGLETON_CAMPAIGN_ID }, SINGLETON_CAMPAIGN_ID), '',
    'a campaign started here must still get the plain refusal, not a reclaim');
  assert.equal(reclaimableCloudId({}, SINGLETON_CAMPAIGN_ID), '');
});

test('a refusal leaves this Mac monitoring, except when the VM already owns it', async (t) => {
  t.after(() => stopMonitoringWatcher());

  // not_resumable: the engine will not revive that campaign. Nothing moved, so
  // the campaign must stay exactly where it was, still being checked here.
  const nr = reclaimRefusal('not_resumable');
  assert.equal(nr.stopLocal, false, 'a failed handover must leave the campaign where it was');
  assert.match(nr.error, /fresh campaign/);
  assert.doesNotMatch(nr.error, /—/, 'no em dashes in operator copy');

  await adopt();
  assert.equal(getCampaignStatus().state, 'monitoring');
  // Simulating the route's refusal branch: with stopLocal false nothing is
  // stopped, so monitoring is still running afterwards.
  if (nr.stopLocal) await stopMonitoring({ reason: 'test' });
  assert.equal(getCampaignStatus().state, 'monitoring', 'a 409 must not stop the local checks');

  // not_local is the one exception: the VM owns it, so THIS side is the extra
  // owner and leaving both armed is the two-sweeps-one-intro case.
  const nl = reclaimRefusal('not_local');
  assert.equal(nl.stopLocal, true);
  assert.match(nl.error, /already running on the Cloud VM/);
  if (nl.stopLocal) await stopMonitoring({ reason: 'test' });
  assert.equal(getCampaignStatus().state, 'done', 'this Mac stops watching a campaign the VM owns');
});

// The safety line this whole helper depends on, driven through the REAL
// startCampaign rather than asserted about it. Without the id reset in
// startCampaign, an adopted campaign's cloud id survives on the campaign global
// forever, and the next unrelated local campaign looks cloud-origin: moving THAT
// to the VM would reclaim a different campaign's engine row, possibly someone
// else's, and restart it.
//
// startCampaign is reachable here because the reset happens before the campaign
// touches the network or a browser: this run dies at the sheet fetch (a sheet id
// that does not exist), which is well past the reset and well before any GoLogin
// launch. It takes a few seconds, which is the price of testing the real
// function instead of a paraphrase of it.
test('a fresh local run drops the adopted campaign\'s cloud id', async (t) => {
  t.after(() => stopMonitoringWatcher());
  await adopt();
  assert.equal(reclaimableCloudId(campaign, SINGLETON_CAMPAIGN_ID), 'cloud-42');

  await startCampaign({
    profileIds: [],
    sheetUrl: 'https://docs.google.com/spreadsheets/d/does-not-exist/edit',
    mode: 'connect_only',
    templates: {},
    resumeContext: { totalProcessed: 0 },   // skips the Recent Connections wipe
  });

  assert.equal(campaign.running, false, 'the run ended (it died at the sheet fetch, as intended)');
  assert.equal(campaign.id, SINGLETON_CAMPAIGN_ID, 'startCampaign must restore the singleton id');
  assert.equal(reclaimableCloudId(campaign, SINGLETON_CAMPAIGN_ID), '',
    'a later local campaign must never be able to hand back the adopted campaign\'s engine row');
});
