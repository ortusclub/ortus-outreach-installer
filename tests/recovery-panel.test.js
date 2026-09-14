import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function _followupFixHtml(cid)');
const end = source.indexOf('// Follow-ups this campaign did NOT send', start);
function render(health) {
  const context = { _fuHealth: () => health, _heldFollowupsHtml: () => '<div>Held review retained</div>', escHtml: s => String(s) };
  vm.runInNewContext(source.slice(start, end), context);
  return context._followupFixHtml('campaign-fixture');
}
test('known follow-up login blocks get prominent local-browser recovery, including VM campaigns', () => {
  const html = render({ ok: true, blocked: 2, failed: 0, reason: 'signed-out' });
  assert.match(html, /strip-recovery-panel/);
  assert.match(html, /Follow-ups need login/);
  assert.match(html, /even when the campaign runs on the VM/);
  assert.match(html, /openFollowupLogin/);
  assert.doesNotMatch(html, /retryFollowups|no lead was messaged twice/);
  assert.match(html, /Held review retained/);
});
test('generic failures are not mislabeled login problems and do not get unrelated login buttons', () => {
  const html = render({ ok: true, blocked: 0, failed: 1, reason: 'error', lastError: 'Message box unavailable' });
  assert.match(html, /Follow-ups need attention/);
  assert.doesNotMatch(html, /onclick=|Follow-ups need login/);
});
test('unknown health stays silent and review-only tasks keep their review information', () => {
  assert.equal(render(null), '');
  const html = render({ ok: true, needsReview: 1, interrupted: 1 });
  assert.match(html, /unconfirmed outcome/);
  assert.doesNotMatch(html, /openFollowupLogin|retryFollowups/);
});
