import test from 'node:test';
import assert from 'node:assert/strict';
import { readSavedCampaignHistory } from '../src/saved-campaign-history.js';
import { PROD_URL, DEV_URL } from '../src/engine-target.js';
import { vjCardControlsFor } from '../public/js/vjcard.mjs';
const entry = { campaignId: 'saved-id', name: 'Saved campaign' };
const viewer = { email: 'operator@example.com' };
const snapshots = { 'run-id': { config: { campaignId: 'saved-id' }, ts: 10 }, unrelated: { config: { campaignId: 'other' }, ts: 20 } };
const reply = (status, data) => ({ status, ok: status === 200, json: async () => data });

test('a saved run on development loads even when the app currently views production', async () => {
  const requested = [];
  const result = await readSavedCampaignHistory(entry, viewer, { snapshots, engine: { url: PROD_URL, token: 'test' },
    fetch: async url => {
      requested.push(url);
      if (url.startsWith(PROD_URL)) return reply(404, {});
      if (url.endsWith('/leads')) return reply(200, { leads: [{ status: 'sent' }] });
      return reply(200, { campaign: { id: 'run-id', owner: viewer.email, config: { campaignId: 'saved-id' } }, monitorLog: [{ t: 1, line: 'Sent' }] });
    } });
  assert.equal(result.status, 200);
  assert.equal(result.environment, 'development');
  assert.equal(result.leads.length, 1);
  assert.equal(result.monitorLog[0].line, 'Sent');
  assert.deepEqual(requested, [`${PROD_URL}/api/campaign/run-id`, `${DEV_URL}/api/campaign/run-id`, `${DEV_URL}/api/campaign/run-id/leads`]);
});

test('another operator cannot load lead history for a known run', async () => {
  let requests = 0;
  const result = await readSavedCampaignHistory(entry, viewer, { snapshots, engine: { url: PROD_URL, token: 'test' },
    fetch: async () => { requests++; return reply(200, { campaign: { owner: 'someone-else@example.com', config: { campaignId: 'saved-id' } } }); } });
  assert.equal(result.status, 404);
  assert.equal(requests, 1, 'lead data must not be requested');
});

test('a campaign that has never run does not inherit another saved campaign’s history', async () => {
  const result = await readSavedCampaignHistory({ campaignId: 'new-id' }, viewer, { snapshots,
    fetch: async () => { throw Error('Must not request unrelated runs'); } });
  assert.equal(result.status, 200);
  assert.equal(result.campaign, null);
});

test('a failed engine read is reported instead of mistaken for no run history', async () => {
  const result = await readSavedCampaignHistory(entry, viewer, { snapshots, engine: { url: PROD_URL, token: 'test' }, fetch: async () => reply(503, {}) });
  assert.equal(result.status, 502);
});

test('a historical run cannot start or stop work on the currently selected engine', () => {
  const controls = vjCardControlsFor({ historyOnly: true, campaignId: 'saved-id', state: 'done', totalProcessed: 175 });
  assert.equal(controls.stop, null);
  assert.equal(controls.pause, null);
  assert.equal(controls.restart, null);
  assert.deepEqual(controls.extra, []);
});
