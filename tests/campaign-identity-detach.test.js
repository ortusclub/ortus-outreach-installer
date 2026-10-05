import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ORTUS_DATA_DIR = mkdtempSync(join(tmpdir(), 'ortus-detach-'));
const { saveConfig, getConfig, getConfigById, detachCampaignIdentity } = await import('../src/campaign-configs.js');

test('a plan re-pointed at another account gets its own ID; the running campaign keeps the old one', () => {
  const first = saveConfig('catherine@x.io', { mode: 'mature_profile', maturePlan: { targetProfileIds: ['p1'] } });
  // The page still held catherine's ID when astridah was picked: the record is renamed in place.
  saveConfig('astridah@x.io', { mode: 'mature_profile', maturePlan: { targetProfileIds: ['p2'] } }, { campaignId: first.campaignId });
  assert.equal(getConfig('astridah@x.io').campaignId, first.campaignId);
  const fresh = detachCampaignIdentity(first.campaignId, 'catherine@x.io');
  assert.notEqual(fresh.campaignId, first.campaignId);
  assert.equal(getConfig('astridah@x.io').campaignId, fresh.campaignId);
  assert.deepEqual(getConfig('astridah@x.io').config.maturePlan.targetProfileIds, ['p2']);
  assert.equal(getConfigById(first.campaignId).name, 'catherine@x.io');
});
