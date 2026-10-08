import { sameCampaign } from '../public/js/campaign-lifecycle.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { statusFromItem } from '../public/js/vjcard.mjs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function _bindLiveStatusToCampaign(');
const code = source.slice(start, source.indexOf('// v2.160.46: OPEN on an ACTIVE', start));

function historyHarness(item, fetch) {
  const painted = [];
  const context = vm.createContext({ sameCampaign, statusFromItem, fetch,
    _viewingLocalCampaign: null, _localLive: { name: 'Another campaign', logs: ['Other log'] },
    _boardItemsById: new Map([[item.id, item]]), _snItemsById: new Map(),
    document: { getElementById: () => ({ value: item.name }) }, location: { hash: '#/new' },
    stopViewingCloudCampaign() {}, renderActiveCard: s => painted.push(s), syncLiveStatusVisibility() {}, startPolling() {}, pollStatus() {},
    _cloudLeadsToLog: leads => leads.map(l => ({ line: l.fullName + ' sent' })),
    _mergeCloudLog: (leads, events) => [...leads, ...events].map(e => e.line),
  });
  vm.runInContext(code, context);
  return { context, painted };
}

test('reopening an older local run reads its stored log, independently of the current singleton', async () => {
  const h = historyHarness({ id: 'h-old', campaignId: 'old-id', name: 'Old', where: 'local', bucket: 'done', histIdx: 2 }, async url => {
    assert.equal(url, '/api/history/2/log');
    return { ok: true, json: async () => ({ lines: ['Old campaign sent a connection'] }) };
  });
  h.context._bindLiveStatusToCampaign('h-old');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(h.painted.at(-1).logs), ['Old campaign sent a connection']);
  assert.equal(h.painted.at(-1).historyLogState, 'loaded');
  assert.equal(h.painted.at(-1).name, 'Old');
});

test('changing the opened campaign while history loads discards the old response', async () => {
  let finish;
  const h = historyHarness({ id: 'h-old', name: 'Old', where: 'local', bucket: 'done', histIdx: 2 }, () => new Promise(resolve => { finish = resolve; }));
  h.context._bindLiveStatusToCampaign('h-old');
  const count = h.painted.length;
  h.context._viewingLocalCampaign = { name: 'New', status: {} };
  finish({ ok: true, json: async () => ({ lines: ['Old campaign log'] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.painted.length, count);
});

test('opening saved settings loads their recorded cloud history instead of treating them as a new campaign', async () => {
  const h = historyHarness({ id: 'saved-id', campaignId: 'saved-id', name: 'Saved', where: 'local', bucket: 'saved' }, async url => {
    assert.equal(url, '/api/campaign-configs/by-id/saved-id/history');
    return { ok: true, json: async () => ({ campaign: { mode: 'connect', status: 'cancelled' }, environment: 'development',
      leads: [{ status: 'sent', fullName: 'Person' }], monitorLog: [] }) };
  });
  h.context._bindLiveStatusToCampaign('saved-id');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.painted.at(-1).hasRun, true);
  assert.equal(h.painted.at(-1).historyOnly, true);
  assert.equal(h.painted.at(-1).historyEnvironment, 'development');
  assert.deepEqual(Array.from(h.painted.at(-1).logs), ['Person sent']);
});

test('opening a stopped local campaign binds local status without any cloud request', () => {
  const painted = [];
  const local = { name: 'Sam', running: false, state: null, totalTargets: 5551, totalProcessed: 4, logs: ['Campaign ended'] };
  const context = vm.createContext({ sameCampaign,
    _viewingLocalCampaign: null, _localLive: local,
    _boardItemsById: new Map([['local-active', { name: 'Sam', where: 'local' }]]), _snItemsById: new Map(),
    document: { getElementById: () => ({ value: 'Sam' }) }, location: { hash: '#/new' },
    stopViewingCloudCampaign() {}, renderActiveCard: s => painted.push(s), syncLiveStatusVisibility() {}, startPolling() {}, pollStatus() {},
    fetch() { throw new Error('Must not fetch cloud data'); },
  });
  vm.runInContext(code + ";_bindLiveStatusToCampaign('local-active');", context);
  assert.equal(painted[0]._cloud, false);
  assert.equal(painted[0].running, false);
  assert.equal(painted[0].state, 'done');
  assert.deepEqual(painted[0].logs, ['Campaign ended']);
  const unrelated = context.localCampaignViewStatus({ name: 'Different campaign', running: true, logs: ['Unrelated'] });
  assert.equal(unrelated.name, 'Sam');
  assert.deepEqual(unrelated.logs, ['Campaign ended']);
  const refreshed = context.localCampaignViewStatus({ ...local, logs: ['Check complete'] });
  assert.deepEqual(refreshed.logs, ['Check complete']);
  context.location.hash = '#/';
  const dashboard = context.localCampaignViewStatus({ name: 'Different campaign' });
  assert.equal(dashboard.name, 'Different campaign');
});

test('all dashboard Open entry points reopen saved local settings and never request cloud data', async () => {
  const fn = (startText, endText) => source.slice(source.indexOf(startText), source.indexOf(endText, source.indexOf(startText)));
  const openCode = fn('async function openCampaignForEdit(id)', 'window.openCampaignForEdit =');
  const aliases = fn('async function openCloudLive(id)', 'window.openCloudLive =')
    + fn('async function openRunningCampaignReadOnly(id)', 'window.openRunningCampaignReadOnly =');
  const status = { name: 'Sam', running: false, state: null, totalTargets: 50, totalProcessed: 5, logs: ['Campaign ended'] };
  for (const entry of ['openCampaignForEdit', 'openCloudLive', 'openRunningCampaignReadOnly']) {
    const painted = [];
    const nameInput = { value: '' };
    const context = vm.createContext({ sameCampaign,
      window: {}, location: { hash: '#/' },
      _localLive: status, _viewingLocalCampaign: null,
      _boardItemsById: new Map([['past-1', { name: 'Sam', where: 'local', mode: 'connect_and_introduce' }]]),
      _snItemsById: new Map(), document: { getElementById: () => nameInput },
      localStorage: { setItem() {} },
      loadCampaignConfigByName: async name => { assert.equal(name, 'Sam'); return true; },
      clearCloudEditMode() {}, clearActiveDraft() {}, lockCampaignType() {}, _updateSaveButtonLabel() {},
      goCreateCampaign: () => { context.location.hash = '#/new'; },
      stopViewingCloudCampaign() {}, renderActiveCard: s => painted.push(s),
      syncLiveStatusVisibility() {}, startPolling() {}, pollStatus() {},
      fetch() { throw new Error('Unexpected network request'); },
    });
    vm.runInContext(code + openCode + aliases, context);
    await context[entry]('past-1');
    assert.equal(nameInput.value, 'Sam', entry);
    assert.equal(context.location.hash, '#/new', entry);
    assert.equal(painted.at(-1).name, 'Sam', entry);
    assert.equal(painted.at(-1).state, 'done', entry);
    assert.equal(painted.at(-1)._cloud, false, entry);
    // Repeat after returning to the dashboard, the exact reported regression.
    context.location.hash = '#/';
    await context[entry]('past-1');
    assert.deepEqual(painted.at(-1).logs, ['Campaign ended'], entry);
  }
});
