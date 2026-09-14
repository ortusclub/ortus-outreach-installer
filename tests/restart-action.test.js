import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const action = appSource.slice(appSource.indexOf('let _activeRestartInFlight = false;'), appSource.indexOf('window.dashCopyActiveToQueue ='));
function fixture({ confirm = true, failure = false, missingId = false, campaignId = 'legacy-singleton' } = {}) {
  const calls = [], toasts = [];
  const ctx = { window: {}, _activeCardCloudId: () => null,
    appConfirm: async () => confirm, showCampaignToast: text => toasts.push(text),
    pollStatus: async () => {}, startPolling() {},
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: !failure || !opts, json: async () => opts
        ? { ok: !failure, error: failure ? 'Shutdown unconfirmed' : undefined }
        : { id: campaignId, executionId: missingId ? null : 'run-a', name: 'QA', running: false, state: 'idle' } };
    },
  };
  vm.runInNewContext(action, ctx);
  return { run: ctx.window.dashRestartActive, calls, toasts };
}
test('idle Restart requests a guarded immediate restore, never Stop or queue-only', async () => {
  const f = fixture(); assert.equal(await f.run(), true);
  assert.deepEqual(f.calls.map(c => c.url), ['/api/campaign/status', '/api/campaign/restore']);
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { expectedExecutionId: 'run-a' });
});
test('native API identity matches the real runner constant, not just a UI fixture', () => {
  const runner = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
  assert.match(runner, /export const SINGLETON_CAMPAIGN_ID = 'legacy-singleton'/);
});
test('dashboard alias remains supported while cloud and unknown identities cannot restart the singleton', async () => {
  assert.equal(await fixture({ campaignId: 'local-active' }).run(), true);
  for (const campaignId of ['cloud-campaign-id', '', null, undefined]) {
    const f = fixture({ campaignId: campaignId === undefined ? 'unknown' : campaignId });
    assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 1, 'no stop, queue or restore request for a non-local identity');
  }
});
test('cancel and missing identity make no mutation', async () => {
  for (const options of [{ confirm: false }, { missingId: true }]) {
    const f = fixture(options); assert.equal(await f.run(), false);
    assert.equal(f.calls.length, 1);
  }
});
test('failed shutdown is reported, never painted as restart accepted', async () => {
  const f = fixture({ failure: true }); assert.equal(await f.run(), false);
  assert.match(f.toasts.at(-1), /Restart not confirmed: Shutdown unconfirmed/);
  assert.equal(f.toasts.some(t => t.startsWith('Restart accepted')), false);
});
test('duplicate clicks submit only one restart', async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]);
  assert.equal(f.calls.filter(c => c.url.endsWith('/restore')).length, 1);
});
test('restore route rejects a changed execution before stopping anything', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.post('/api/campaign/restore'");
  const end = source.indexOf('\n});', start) + 4;
  let handler, status, body;
  vm.runInNewContext(source.slice(start, end), {
    app: { post: (_, fn) => { handler = fn; } }, _recoveryInFlight: false,
    campaign: { executionId: 'run-b' }, rejectIfNoOperatorEmail: () => false,
    stopLocalAndConfirm: () => assert.fail('must not stop another run'),
  });
  await handler({ body: { expectedExecutionId: 'run-a' } }, {
    status: s => { status = s; return { json: b => { body = b; } }; },
  });
  assert.equal(status, 409); assert.equal(body.ok, false);
});

test('historical restart preserves full settings and requires confirmation', async () => {
  const source = appSource.slice(appSource.indexOf('const _historyRestartInFlight = new Set();'), appSource.indexOf('window.restartLocalFromItem ='));
  for (const confirmed of [false, true]) {
    let submitted;
    const settings = { profileIds: ['sender'], sheetUrl: 'sheet', sheetGid: '42',
      excludedUrls: ['held'], benchedProfileIds: ['benched'], templates: { primaryUrl: 'primary' },
      resumeContext: { totalProcessed: 99 } };
    const ctx = { structuredClone, _boardItemsById: new Map([['a', { name: 'QA', mode: 'connect_only', srcSettings: settings }]]),
      appConfirm: async () => confirmed, showCampaignToast() {},
      fetch: async (_, opts) => { submitted = JSON.parse(opts.body); return { ok: true }; } };
    const restart = vm.runInNewContext(source + '\nrestartLocalFromItem;', ctx);
    await restart('a', true);
    if (!confirmed) assert.equal(submitted, undefined);
    else {
      assert.equal(submitted.sheetGid, '42');
      assert.deepEqual(submitted.excludedUrls, ['held']);
      assert.deepEqual(submitted.benchedProfileIds, ['benched']);
      assert.equal(submitted.templates.primaryUrl, 'primary');
      assert.equal(submitted.resumeContext, undefined);
    }
    assert.equal(settings.resumeContext.totalProcessed, 99);
  }
});
