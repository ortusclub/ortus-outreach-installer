import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldFirePostCampaignIntro } from '../src/post-campaign-bulk-check.js';

// The post-campaign acceptance sweep must only fire a group intro for CC+IC
// (connect_and_introduce). A CC+DM campaign launched after a CC+IC config was
// filled in carries leftover primaryName/primaryIntroBody values; without a
// mode gate the sweep would send a real group intro on a plain DM campaign.

test('fires for connect_and_introduce with primary fields and connections', () => {
  const entry = {
    mode: 'connect_and_introduce',
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'Hi {first name}, meet Sam.',
  };
  assert.equal(shouldFirePostCampaignIntro(entry, ['https://linkedin.com/in/a']), true);
});

test('does NOT fire for connect_and_message even with leftover primary fields', () => {
  // The bug: stale CC+IC config on a CC+DM campaign.
  const entry = {
    mode: 'connect_and_message',
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'Hi {first name}, meet Sam.',
  };
  assert.equal(shouldFirePostCampaignIntro(entry, ['https://linkedin.com/in/a']), false);
});

test('does NOT fire when primaryIntroBody is missing', () => {
  const entry = {
    mode: 'connect_and_introduce',
    primaryName: 'Sam Adcock',
    primaryIntroBody: '',
  };
  assert.equal(shouldFirePostCampaignIntro(entry, ['https://linkedin.com/in/a']), false);
});

test('does NOT fire when there are no connected URLs', () => {
  const entry = {
    mode: 'connect_and_introduce',
    primaryName: 'Sam Adcock',
    primaryIntroBody: 'Hi {first name}, meet Sam.',
  };
  assert.equal(shouldFirePostCampaignIntro(entry, []), false);
});

test('does NOT fire for connect_only with no primary fields', () => {
  const entry = { mode: 'connect_only', primaryName: '', primaryIntroBody: '' };
  assert.equal(shouldFirePostCampaignIntro(entry, ['https://linkedin.com/in/a']), false);
});
