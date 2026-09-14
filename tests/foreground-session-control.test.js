import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { preparePrimarySession } from '../src/primary-session-control.js';

const source = readFileSync(new URL('../src/campaign.js', import.meta.url), 'utf8');
const start = source.indexOf('    async function ensureOpen(');
const end = source.indexOf('\n    /**\n     * v2.14 — idle bulk-check', start);
assert.ok(start >= 0 && end > start);

for (const mode of ['connect_only', 'connect_and_introduce', 'connect_and_message', 'message_only', 'introduce_back', 'open_profile_only', 'inmail_only', 'check_status']) {
  test(`${mode}: foreground late launch is cancelled before login or outreach`, async () => {
    const controller = new AbortController();
    let released = 0, closed = 0;
    const campaign = { _abortController: controller, _abort: false };
    const run = vm.runInNewContext(source.slice(start, end) + '\nensureOpen;', {
      campaign, isOrphan: () => false, sessions: new Map(), profileNameCache: {},
      token: 'fixture', mode, preflightCheckStatus: false,
      taskOwner: { campaignId: `fixture-${mode}`, campaignRunId: 'run' },
      preparePrimarySession, log() {}, setAction() {}, pushError() {},
      browserSemaphore: { getStatus: () => ({ count: 0, max: 1 }), acquire: async () => {}, release() { released++; } },
      launchProfile: async () => { controller.abort(); return { page: {} }; },
      closeProfile: async () => { closed++; return { browserClosed: true }; },
      ensureProfileLoggedIn: async () => assert.fail('cancelled session must not reach login or outreach'),
    });
    assert.equal(await run('fixture-account'), null);
    assert.equal(closed, 1);
    assert.equal(released, 1);
  });
}
