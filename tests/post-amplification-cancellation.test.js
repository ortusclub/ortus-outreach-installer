import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { preparePrimarySession } from '../src/primary-session-control.js';

const source = readFileSync(new URL('../src/linkedin/post-amplification.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('export async function runAmplification(')).replace('export ', '');
function fixture({ lateStop = false, interrupted = false } = {}) {
  const controller = new AbortController();
  let launched = 0, closed = 0, engaged = 0;
  const dedup = interrupted ? { post: { account: { interrupted: true } } } : {};
  const run = vm.runInNewContext(fn + '\nrunAmplification;', {
    process: { env: {} }, preparePrimarySession,
    browserSemaphore: { acquire: async () => {}, release() {} },
    loadDedupState: async () => dedup, saveDedupState: async () => {},
    isAlreadyEngaged: () => false,
    recordEngagement: (state, post, account, value) => { state[post] ||= {}; state[post][account] = value; },
    launchProfile: async () => { launched++; if (lateStop) controller.abort(); return { page: {} }; },
    closeProfile: async () => { closed++; return { browserClosed: true }; },
    pickReaction: () => 'Like',
    engagePost: async () => {
      assert.equal(dedup.post.account.interrupted, true, 'unknown outcome must be persisted before engagement');
      engaged++; return { ok: true, commented: true };
    },
  });
  return { run: () => run({ postUrl: 'post', accountConfigs: [{ profileId: 'account', profileName: 'fixture', comment: true, commentText: 'fixture' }],
    status: {}, signal: controller.signal, taskOwner: { campaignId: 'post-amplification', campaignRunId: 'fixture' } }),
    counts: () => ({ launched, closed, engaged }) };
}
test('Post Amplification Stop during launch never engages', async () => {
  const f = fixture({ lateStop: true }); await f.run();
  assert.deepEqual(f.counts(), { launched: 1, closed: 1, engaged: 0 });
});
test('Post Amplification preserves normal confirmed engagement', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.counts(), { launched: 1, closed: 1, engaged: 1 });
});
test('an unknown previous comment is held instead of posted again', async () => {
  const f = fixture({ interrupted: true }); await f.run();
  assert.deepEqual(f.counts(), { launched: 0, closed: 0, engaged: 0 });
});
