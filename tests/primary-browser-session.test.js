import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPrimarySession, primaryBrowserProblemFromUrl, waitForPrimaryRecovery } from '../src/primary-browser-session.js';

test('primary redirect is not an empty inbox', async () => {
  for (const path of ['login', 'uas/login', 'authwall']) assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/' + path).state, 'logged-out');
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/checkpoint/challenge').state, 'checkpoint');
  assert.equal(primaryBrowserProblemFromUrl('https://www.linkedin.com/mynetwork/'), null);
  const result = await inspectPrimarySession({ goto: async () => {}, url: () => 'https://www.linkedin.com/uas/login' });
  assert.equal(result.state, 'logged-out');
});
test('recovery wait releases on retry or Stop and clears its callback', async () => {
  for (const stop of [true, false]) {
    const campaign = {}, controller = new AbortController();
    const waiting = waitForPrimaryRecovery(campaign, { state: 'logged-out' }, 'local-browser', controller.signal);
    assert.equal(campaign.primaryRecovery.state, 'logged-out');
    if (stop) controller.abort(); else campaign._retryPrimary();
    assert.equal(await waiting, !stop);
    assert.equal(campaign.primaryRecovery, null);
    assert.equal(campaign._retryPrimary, null);
  }
});
