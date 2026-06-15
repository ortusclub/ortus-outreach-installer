import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaign, confirmLogin, getCampaignStatus } from '../src/campaign.js';

test('confirmLogin sets _loginDone', () => {
  campaign._loginDone = false;
  confirmLogin();
  assert.equal(campaign._loginDone, true);
});

test('getCampaignStatus surfaces awaitingLogin', () => {
  campaign.awaitingLogin = { profileId: 'local-browser', pName: 'You', since: 1 };
  assert.deepEqual(getCampaignStatus().awaitingLogin, { profileId: 'local-browser', pName: 'You', since: 1 });
  campaign.awaitingLogin = null;
  assert.equal(getCampaignStatus().awaitingLogin, null);
});
