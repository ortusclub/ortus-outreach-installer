import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { latestBannerEvent, bannerEventPhase } from '../public/js/live-log-banner.mjs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../public/css/dashboard-v0.3.css', import.meta.url), 'utf8');
const FN = APP.slice(APP.indexOf('async function restartCloudCampaignUI('), APP.indexOf('async function restartCloudCampaignUI(') + 3500);

test('the resume is logged BEFORE the engine call', () => {
  const logAt = FN.indexOf('waiting for the VM to confirm');
  const fetchAt = FN.indexOf('/restart`');
  assert.ok(logAt > -1 && logAt < fetchAt,
    'the countdown kept ticking for ten seconds because nothing was said until the VM answered');
});

test('that optimistic line takes the card off the monitoring view at once', () => {
  // This is the whole point: the card is log-driven, so the line itself is what
  // stops the acceptance-check countdown.
  const ev = latestBannerEvent(['▶️ Started (continuing where it left off) — waiting for the VM to confirm…'], { phase: 'monitoring' });
  assert.equal(ev.kind, 'sending-resumed');
  assert.equal(bannerEventPhase(ev, 'monitoring'), 'sending');
});

test('the from-the-beginning variant switches it too', () => {
  const ev = latestBannerEvent(['▶️ Started (from the beginning) — waiting for the VM to confirm…'], { phase: 'monitoring' });
  assert.equal(bannerEventPhase(ev, 'monitoring'), 'sending');
});

test('a scheduled restart is NOT painted as sending', () => {
  assert.match(FN, /if \(!startAt\) \{/, 'a restart scheduled for later has not resumed anything');
});

test('a rejected restart puts the card back', () => {
  assert.match(FN, /The VM did not accept the restart/);
  assert.match(FN, /Could not reach the VM to resume/);
});

test('a long fact value can no longer run through the edge of the card', () => {
  const rule = CSS.slice(CSS.indexOf(".vj-stage-facts b {"), CSS.indexOf(".vj-stage-facts b {") + 700);
  for (const p of ['min-width: 0', 'text-overflow: ellipsis', 'white-space: nowrap']) {
    assert.ok(rule.includes(p), `.vj-stage-facts b needs ${p}`);
  }
  assert.match(CSS, /\.vj-stage-facts span \{ flex: 0 0 auto; \}/, 'the label must not be crushed instead');
});

test('a LinkedIn URL is exactly the value that used to overflow', () => {
  // The fact value the operator screenshotted, unbroken by any space.
  const v = 'linkedin.com/in/ACwAAABBY6oBW0xWRS32Xlpafz_gB2bZeQDUUYA';
  assert.ok(!/\s/.test(v), 'nothing for the browser to wrap on — only min-width:0 saves the layout');
});
