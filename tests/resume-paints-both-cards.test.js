import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// v3.1.48.116 repainted only window.__cloudActiveStatus — the campaign tab's
// card. The operator was on the DASHBOARD strip, so the click painted nothing
// and the card only moved when the poll landed: its own "updated Ns ago" read
// 3, 4, 5, 6 before three log lines appeared at once (recording, 20:12).
test('there is a card-agnostic resuming flag, not just a status field', () => {
  assert.match(APP, /const _resumingIds = new Set\(\)/);
  assert.match(APP, /_resumingIds\.add\(String\(id\)\)/);
  assert.match(APP, /_resumingIds\.delete\(String\(id\)\)/);
});

test('the click repaints the dashboard strip without a board rebuild', () => {
  const i = APP.indexOf('function _repaintCloudStripNow');
  assert.ok(i > 0, 'the strip is never repainted on the click');
  const body = APP.slice(i, i + 700);
  assert.match(body, /data-cid=/, 'the strip is found by its own id');
  assert.ok(!/renderCampaignsBoard|_forceCloudItemsAfterAction|_refreshCloudItems/.test(body),
    'a rebuild refetches every campaign — that IS the latency being hidden');
  assert.match(body, /classList\.remove\('is-monitor', 'is-monitoring'\)/);
  assert.match(body, /classList\.add\('is-resuming'\)/);
});

test('the log line reaches the strip too', () => {
  const i = APP.indexOf('function _repaintCloudStripLog');
  assert.ok(i > 0, 'the strip log is never appended to on the click');
  const body = APP.slice(i, i + 800);
  assert.match(body, /insertAdjacentHTML\('beforeend', v3RenderLogLine/);
  assert.match(body, /children\.length > 15/, 'the box shows 15, so trim to 15');
});

test('both repaints happen on the click, before the engine is asked', () => {
  const i = APP.indexOf('async function restartCloudCampaignUI');
  const body = APP.slice(i, i + 5000);
  assert.ok(body.indexOf('_markCloudResuming(id, true)') < body.indexOf('/restart'));
  assert.ok(body.indexOf('_pushCloudEventNow(id, fromStart') < body.indexOf('/restart'));
});

test('the flag has both ways out — engine moved on, or it timed out', () => {
  const i = APP.indexOf('function _isResumingId');
  assert.ok(i > 0, 'nothing expires the flag');
  const body = APP.slice(i, i + 700);
  assert.match(body, /st !== 'monitoring'/, 'a landed resume clears it');
  assert.match(body, /90000/, 'a resume that never lands must not pin the card green');
});

test('the card colour asks the flag, whichever renderer is painting', () => {
  const i = APP.indexOf('function applyVjCardAppearance');
  const body = APP.slice(i, i + 5000);
  assert.match(body, /_isResumingId\(status && status\.id, state\)/);
  assert.match(body, /const monitoring = !_resumingNow/);
});
