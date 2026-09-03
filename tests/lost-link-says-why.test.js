import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { linkIsLost, LOST_LINK_AFTER_S } from '../public/js/live-activity.mjs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// "This Mac cannot see the campaign" needs 90s of silence, not one bad poll.
// The reason was captured onto the status object, shown in the hero and thrown
// away, so every occurrence started its diagnosis from zero.
test('the hero still needs a real quiet spell, not a blip', () => {
  assert.equal(LOST_LINK_AFTER_S, 90);
  assert.equal(linkIsLost(89), false);
  assert.equal(linkIsLost(91), true);
  assert.equal(linkIsLost(600, true), false, 'a local campaign has no VM link to lose');
});

test('the reason reaches the LOG, not only the banner', () => {
  assert.match(APP, /No answer from the VM \(\$\{_why\}\)/);
  assert.match(APP, /_pushCloudEvent\(id, `⚠️ No answer from the VM/);
});

test('one line per quiet spell, not one per failed poll', () => {
  assert.match(APP, /const _cloudQuietSince = new Map\(\)/);
  assert.match(APP, /if \(!_cloudQuietSince\.has\(String\(id\)\)\)/);
});

test('recovery is logged too, with how long it was quiet', () => {
  assert.match(APP, /The VM is answering again — it was quiet for \$\{_quiet\}s/);
  assert.match(APP, /_cloudQuietSince\.delete\(String\(id\)\)/);
});

test('the hero offers a way to check without waiting for the poll', () => {
  assert.match(APP, /window\.retryCloudLink/);
  assert.match(APP, /Check the connection now/);
});

test('the retry block comes down when the link returns', () => {
  const i = APP.indexOf('function _applyLostLinkOverride');
  const body = APP.slice(i, i + 1800);
  assert.match(body, /if \(!lost\) \{/);
  assert.match(body, /back\.dataset\.lostLinkActs/, 'or it outlives the problem');
});

test('the first fresh poll restores the real card instead of leaving a stale lost-link headline', () => {
  const i = APP.indexOf('function _applyLostLinkOverride');
  const body = APP.slice(i, i + 1800);
  assert.match(body, /const wasLost = stage\.dataset\.lostLink === '1'/);
  assert.match(body, /const status = _stageStatus\.get\(stage\)/);
  assert.match(body, /if \(root && status\) renderLiveStage\(root, status\)/);
});
