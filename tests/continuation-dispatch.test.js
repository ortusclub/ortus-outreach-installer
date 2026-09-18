import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkContext } from '../public/js/check-context.mjs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const part = source.slice(source.indexOf('const _continuationChoicesBusy ='), source.indexOf('// Restart a STOPPED/CANCELLED/ERRORED cloud campaign'));
function fixture(choice, { changed = false, vmMode = false, historyExecution, monitoringScope = 'campaign' } = {}) {
  const calls = [], messages = []; let reads = 0;
  const status = { id: vmMode ? 'cloud-a' : 'legacy-singleton', executionId: 'run-a', mode: 'connect_and_introduce',
    state: 'idle', status: 'cancelled', name: 'QA', profileIds: ['sender'], sheetUrl: 'sheet', monitoringScope,
    taskCampaignId: 'legacy-singleton', campaignRunId: 'owner-a', monitoringUntil: '2099-01-01', updated_at: '2026-09-09T12:00:00Z' };
  const ctx = { window: { dashRestartActive: async id => calls.push(['sending', id]) },
    structuredClone,
    _boardItemsById: new Map(historyExecution ? [['history-a', { hist: { executionId: historyExecution }, mode: status.mode, srcSettings: { sheetUrl: 'old-sheet', profileIds: ['old-sender'] } }]] : []), checkContext, chooseContinuation: async () => choice,
    fetch: async () => ({ ok: true, json: async () => ({ ...status, executionId: changed && ++reads > 1 ? 'other' : 'run-a' }) }),
    requestConfirmedResume: async (_, url, options) => { calls.push([url, JSON.parse(options.body)]); return { ok: true }; },
    showCampaignToast: m => messages.push(m), pollStatus: async () => {}, renderCampaignsBoard() {},
    restartCloudCampaignUI: async (...args) => calls.push(['vm-sending', ...args]),
    cloudCheckNow: async (...args) => calls.push(['vm-check', ...args]),
  };
  vm.runInNewContext(part, ctx);
  return { ctx, calls, messages, run: () => ctx.window.openCampaignContinuation(historyExecution ? 'history-a' : vmMode ? 'cloud-a' : 'local-active', vmMode ? 'vm' : 'local') };
}
test('continuation choice remains locked while sending confirmation is pending', async () => {
  const f = fixture('sending');
  let release, entered;
  const started = new Promise(r => entered = r);
  f.ctx.window.dashRestartActive = async () => {
    f.calls.push(['sending']); entered();
    await new Promise(r => release = r);
  };
  const first = f.run(); await started;
  await f.run();
  assert.equal(f.calls.length, 1);
  release(); await first;
});
test('local choices dispatch to separate commands; cancel makes no mutation', async () => {
  const expected = { sending: 'sending', check: '/api/bulk-check-now', monitoring: '/api/campaign/monitoring/resume' };
  for (const choice of [null, ...Object.keys(expected)]) {
    const f = fixture(choice); await f.run();
    assert.equal(f.calls.length, choice ? 1 : 0);
    if (choice) assert.equal(f.calls[0][0], expected[choice]);
    if (choice === 'check') {
      assert.equal(f.calls[0][1].continuationCheck, true);
      assert.equal(f.calls[0][1].expectedExecutionId, 'run-a');
      assert.equal(f.calls[0][1].historicalContinuation, false);
      assert.deepEqual(f.calls[0][1].profileIds, ['sender']);
    }
  }
});
test('VM monitor does not restart sender; VM sending preserves saved settings', async () => {
  const m = fixture('monitoring', { vmMode: true }); await m.run();
  assert.equal(m.calls[0][0], '/api/campaign/cloud/cloud-a/monitoring/resume');
  const s = fixture('sending', { vmMode: true }); await s.run();
  assert.deepEqual(s.calls[0], ['vm-sending', 'cloud-a', false, undefined, true, true]);
});
test('VM one-check choice stays on the VM check endpoint', async () => {
  const f = fixture('check', { vmMode: true }); await f.run();
  assert.deepEqual(f.calls[0], ['vm-check', 'cloud-a', null, 'campaign']);
  assert.equal(f.calls.some(([url]) => url === '/api/bulk-check-now'), false);
});
test('tab-wide monitoring sends immediate checks to all sheet senders on either machine', async () => {
  const local = fixture('check', { monitoringScope: 'tab' }); await local.run();
  assert.equal(local.calls[0][1].allSenders, true);
  assert.equal(local.calls[0][1].profileIds, undefined);
  const vm = fixture('check', { vmMode: true, monitoringScope: 'tab' }); await vm.run();
  assert.deepEqual(vm.calls[0], ['vm-check', 'cloud-a', null, 'all']);
});
test('changed local execution cancels a one-check request', async () => {
  const f = fixture('check', { changed: true }); await f.run();
  assert.equal(f.calls.length, 0); assert.match(f.messages.at(-1), /changed/);
});
test('dashboard history uses current monitoring only when execution identities match', async () => {
  const matching = fixture('monitoring', { historyExecution: 'run-a' }); await matching.run();
  assert.equal(matching.calls[0][0], '/api/campaign/monitoring/resume');
  assert.equal(matching.calls[0][1].executionId, 'run-a');
  const older = fixture('monitoring', { historyExecution: 'other-run' }); await older.run();
  assert.equal(older.calls.length, 0); assert.match(older.messages.at(-1), /unavailable/);
});
