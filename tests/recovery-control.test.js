import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { confirmRecoveryShutdown, unresolvedHandoverLeads, waitForDestinationStart } from '../src/recovery-control.js';

const fixture = overrides => ({ generation: 1, currentGeneration: () => 1, timeoutMs: 30,
  stop: async () => {}, close: async () => ({ browserClosed: true }), tracking: async () => ({ ok: true }),
  status: () => ({ running: false, state: 'done' }), ...overrides });

test('destination startup reports confirmed, failed and pending separately', async () => {
  assert.equal((await waitForDestinationStart({ started: () => true, failure: () => null })).destinationStarted, true);
  const failed = await waitForDestinationStart({ started: () => true, failure: () => new Error('startup failed') });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /startup failed/);
  const pending = await waitForDestinationStart({ started: () => false, failure: () => null, timeoutMs: 1 });
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);
});
test('recovery requires closure, tracking and ended foreground', async () => {
  assert.equal((await confirmRecoveryShutdown(fixture())).ok, true);
  for (const override of [
    { close: async () => ({ browserClosed: false }) },
    { tracking: async () => ({ ok: false }) },
    { status: () => ({ running: true }) },
    { currentGeneration: () => 2 },
    { close: async () => { throw new Error('unknown process'); } },
    { close: () => new Promise(() => {}) },
  ]) assert.equal((await confirmRecoveryShutdown(fixture(override))).ok, false);
});
test('uncertain handover entries remain review-only', () => {
  const leads = ['pending', 'sent', 'in_progress', 'interrupted', 'needs_review', 'needs-review'].map(status => ({ status }));
  assert.deepEqual(unresolvedHandoverLeads(leads).map(l => l.status), ['in_progress', 'interrupted', 'needs_review', 'needs-review']);
});
test('actual Restore refuses missing or stale proof without force-closing or resetting the runner', async () => {
  const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function restoreCampaign(');
  const end = source.indexOf('async function awaitUnpause', start);
  const campaign = { running: true, _generation: 3 };
  const restore = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nrestoreCampaign;', {
    campaign, closeAllProfiles: () => assert.fail('global closure'), closeLocalBrowser: () => assert.fail('global closure'),
  });
  assert.equal((await restore()).ok, false);
  assert.equal((await restore({ shutdownProof: { ok: true, generation: 2 } })).ok, false);
  assert.equal((await restore({ shutdownProof: { ok: true, generation: 3 } })).ok, false);
  assert.equal(campaign.running, true);
});

test('confirmed idle Restore submits saved settings without a global kill', async () => {
  const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function restoreCampaign(');
  const end = source.indexOf('async function awaitUnpause', start);
  const campaign = { running: false, _generation: 3 };
  let submitted;
  const restore = vm.runInNewContext(source.slice(start, end).replace('export ', '') + '\nrestoreCampaign;', {
    campaign, _lastRunSettings: { name: 'fixture', profileIds: ['account'], sheetUrl: 'fixture-sheet' },
    log() {}, startCampaign: async settings => { submitted = settings; },
    closeAllProfiles: () => assert.fail('global closure'), closeLocalBrowser: () => assert.fail('global closure'),
  });
  assert.equal((await restore({ shutdownProof: { ok: true, generation: 3 } })).ok, true);
  assert.equal(submitted.sheetUrl, 'fixture-sheet');
});

test('adopted monitoring shuts down locally before reclaim is requested', async () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function handoverToVm(');
  const end = server.indexOf("app.post('/api/campaign/:id/handover'", start);
  let reclaimed = false, status;
  const run = vm.runInNewContext(server.slice(start, end) + '\nhandoverToVm;', {
    handoverLogSnapshot: () => [],
    campaign: { running: false, state: 'monitoring', id: 'cloud-fixture' }, SINGLETON_CAMPAIGN_ID: 'local-active',
    reclaimableCloudId: () => 'cloud-fixture', stopLocalAndConfirm: async () => ({ ok: false }),
    reclaimCloudCampaign: async () => { reclaimed = true; },
  });
  await run('cloud-fixture', { body: {} }, { status(value) { status = value; return this; }, json() {} });
  assert.equal(status, 409);
  assert.equal(reclaimed, false);
});

test('local startup requests a stop before a machine move', async () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function handoverToVm(');
  const end = server.indexOf("app.post('/api/campaign/:id/handover'", start);
  let stopCalled = false;
  const run = vm.runInNewContext(server.slice(start, end) + '\nhandoverToVm;', {
    handoverLogSnapshot: () => [],
    campaign: { running: true, state: 'running', currentAction: { phase: 'starting' } },
    getLastRunSettings: () => ({ sheetUrl: 'https://sheet.test', mode: 'connect_only', profileIds: ['p1'] }),
    isCloudMode: () => true,
    withGid: value => value,
    fetchSheet: async () => [{ url: 'https://linkedin.com/in/one' }],
    extractLinkedInUrl: row => row.url,
    sheetProcessedUrls: () => [],
    stopLocalAndConfirm: async () => { stopCalled = true; return { ok: false, reason: 'shutdown-unconfirmed' }; },
  });
  let code, body;
  await run('local-active', { body: {} }, {
    status(value) { code = value; return this; }, json(value) { body = value; },
  });
  assert.equal(code, 409);
  assert.equal(body.reason, 'source_still_running');
  assert.equal(stopCalled, true);
});
