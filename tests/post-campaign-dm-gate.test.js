import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldFirePostCampaignDm } from '../src/post-campaign-bulk-check.js';

// Mirror of shouldFirePostCampaignIntro, for CC+DM. The post-campaign sweep
// must fire the auto-DM for connect_and_message entries that have a DM body and
// newly-connected leads — symmetrically to how it fires the auto-intro for
// connect_and_introduce. Previously this path had NO auto-DM at all, so CC+DM
// acceptances during the 6h/7-day background window never got a DM.

test('fires for connect_and_message with ccDmBody and connections', () => {
  const entry = { mode: 'connect_and_message', ccDmBody: 'hi {first name}, great to connect' };
  assert.equal(shouldFirePostCampaignDm(entry, ['https://linkedin.com/in/a']), true);
});

test('does NOT fire without a ccDmBody (nothing to send)', () => {
  const entry = { mode: 'connect_and_message', ccDmBody: '' };
  assert.equal(shouldFirePostCampaignDm(entry, ['https://linkedin.com/in/a']), false);
});

test('does NOT fire for connect_and_introduce (wrong mode — that path fires an intro)', () => {
  const entry = { mode: 'connect_and_introduce', ccDmBody: 'leftover dm body' };
  assert.equal(shouldFirePostCampaignDm(entry, ['https://linkedin.com/in/a']), false);
});

test('does NOT fire when there are no connected URLs', () => {
  const entry = { mode: 'connect_and_message', ccDmBody: 'hi there' };
  assert.equal(shouldFirePostCampaignDm(entry, []), false);
});

test('does NOT fire for a null/empty entry', () => {
  assert.equal(shouldFirePostCampaignDm(null, ['https://linkedin.com/in/a']), false);
});

// Sanity: DM and intro gates are mutually exclusive on the same entry —
// an entry can never trip both (different required mode).
test('DM and intro gates never both fire for one entry', async () => {
  const { shouldFirePostCampaignIntro } = await import('../src/post-campaign-bulk-check.js');
  const urls = ['https://linkedin.com/in/a'];
  const dm = { mode: 'connect_and_message', ccDmBody: 'x', primaryName: 'P', primaryIntroBody: 'b' };
  const ic = { mode: 'connect_and_introduce', ccDmBody: 'x', primaryName: 'P', primaryIntroBody: 'b' };
  assert.equal(shouldFirePostCampaignDm(dm, urls) && shouldFirePostCampaignIntro(dm, urls), false);
  assert.equal(shouldFirePostCampaignDm(ic, urls) && shouldFirePostCampaignIntro(ic, urls), false);
});
