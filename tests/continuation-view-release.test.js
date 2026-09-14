import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const part = source.slice(source.indexOf('window.dashRestartActive = async'), source.indexOf('window.dashCopyActiveToQueue = async'));
for (const outcome of ['accepted', 'rejected', 'cancelled', 'navigated']) {
  test(`native continuation releases historical card only on acceptance (${outcome})`, async () => {
    const old = { id: 'old-history' }, other = { id: 'other-history' };
    let polled = false;
    const ctx = { window: {}, _viewingLocalHistoryStatus: old, _activeRestartInFlight: false,
      _activeCardCloudId: () => null, showCampaignToast() {}, startPolling() {},
      stopViewingLocalHistoryCampaign() { ctx._viewingLocalHistoryStatus = null; },
      appConfirm: async () => outcome !== 'cancelled',
      fetch: async url => {
        if (url.endsWith('/status')) return { ok: true, json: async () => ({ id: 'legacy-singleton', executionId: 'run-a' }) };
        if (outcome === 'navigated') ctx._viewingLocalHistoryStatus = other;
        return { ok: outcome !== 'rejected', json: async () => ({ ok: outcome !== 'rejected', error: 'Rejected' }) };
      },
      pollStatus: async () => {
        polled = true;
        assert.equal(ctx._viewingLocalHistoryStatus, outcome === 'navigated' ? other : null);
      },
    };
    vm.runInNewContext(part, ctx);
    await ctx.window.dashRestartActive('run-a');
    assert.equal(ctx._viewingLocalHistoryStatus, outcome === 'accepted' ? null : outcome === 'navigated' ? other : old);
    assert.equal(polled, ['accepted', 'navigated'].includes(outcome));
  });
}
