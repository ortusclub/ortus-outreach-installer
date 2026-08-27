import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('a stopped local account with an expired session maps to needs-login, not throttled', () => {
  assert.match(src, /session expired/);
  assert.match(src, /needsLogin \? 'needslogin'/);
  const pill = src.slice(src.indexOf('function _stageAcctPill'), src.indexOf('function _stageDrawerHtml'));
  assert.ok(pill.indexOf("if (a.needsLogin) { cls = 'bad'; text = 'Logged out'; }")
    < pill.indexOf("else if (a.parkReason === 'throttle'"));
});

test('generic stopped accounts are not automatically labelled throttled', () => {
  assert.match(src, /else if \(a\.parked\) \{/);
  assert.match(src, /Stopped — \$\{reason\}/);
  assert.doesNotMatch(src, /else if \(a\.parked \|\| a\.parkReason === 'throttle'\)/);
});

test('expanded needs-login account offers its exact GoLogin profile', () => {
  const drawer = src.slice(src.indexOf('function _stageDrawerHtml'), src.indexOf('function _stageFixHtml'));
  assert.match(drawer, /a\.needsLogin \|\| \(a\.sweepAction/,
    'both sending and monitoring login failures must use the same recovery UI');
  assert.match(drawer, /openProfileBrowser\('\$\{escHtml\(a\.profileId\)\}'\)/,
    'the button must open the selected account, never a campaign-level or guessed profile');
  assert.match(drawer, />Open GoLogin profile<\/button>/);
});
