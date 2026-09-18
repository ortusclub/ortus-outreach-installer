import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function pauseCloudCampaignUI(');
const end = source.indexOf('window.pauseCloudCampaignUI = pauseCloudCampaignUI;', start);

test('VM pause still pending on HTTP 202 reports progress, not failure or completion', async () => {
  const events = [];
  const context = {
    window: {},
    _confirmFirstPause: async () => true,
    _cloudMutationRequest: async () => { const error = new Error('Shutdown is not yet confirmed'); error.pending = true; throw error; },
    _pushCloudEventNow: (id, line) => events.push(['event', id, line]),
    _pushCloudEvent: () => { throw new Error('must not claim pause is complete'); },
    showCampaignToast: line => events.push(['toast', line]),
    _viewingCloudId: 'campaign-1',
    _refreshCloudActiveStatus: async () => events.push(['refresh']),
    renderCloudCampaigns: () => events.push(['campaigns']),
    renderCampaignsBoard: () => events.push(['board']),
  };
  vm.runInNewContext(`${source.slice(start, end)}\nwindow.pauseCloudCampaignUI = pauseCloudCampaignUI;`, context);
  assert.equal(await context.window.pauseCloudCampaignUI('campaign-1', false), true);
  assert.match(events.find(row => row[0] === 'toast')[1], /Pause requested/);
  assert.match(events.find(row => row[0] === 'event')[2], /waiting for the current lead/);
  assert.ok(events.some(row => row[0] === 'refresh'));
});
