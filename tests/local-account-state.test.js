import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
// The accounts panel's own version of this rule moved into vjcard.mjs when the
// row was redesigned (2026-09-02), so it could be tested by calling it rather
// than by reading source. The rule is unchanged; only its address is.
const vj = fs.readFileSync(new URL('../public/js/vjcard.mjs', import.meta.url), 'utf8');
const { acctRowState } = await import('../public/js/vjcard.mjs');

test('a stopped local account with an expired session maps to needs-login, not throttled', () => {
  assert.match(src, /session expired/);
  assert.match(src, /needsLogin \? 'needslogin'/);
  const pill = src.slice(src.indexOf('function _stageAcctPill'), src.indexOf('function _stageDrawerHtml'));
  assert.ok(pill.indexOf("if (a.needsLogin) { cls = 'bad'; text = 'Logged out'; }")
    < pill.indexOf("else if (a.parkReason === 'throttle'"));
});

test('generic stopped accounts are not automatically labelled throttled', () => {
  assert.match(src, /else if \(a\.parked\) \{/);
  assert.match(vj, /Stopped — \$\{reason\}/);
  assert.doesNotMatch(src, /else if \(a\.parked \|\| a\.parkReason === 'throttle'\)/);
  assert.doesNotMatch(vj, /else if \(a\.parked \|\| a\.parkReason === 'throttle'\)/);
  // The same rule, asserted by asking rather than by reading: a park with an
  // unrecognised reason reports THAT reason, and is never called throttled.
  const st = acctRowState({ parked: true, parkReason: 'checkpoint' });
  assert.equal(st.status, 'Stopped — checkpoint');
  assert.deepEqual(st.pills, [['bad', 'Stopped']]);
});

test('expanded needs-login account offers its exact GoLogin profile', () => {
  const drawer = src.slice(src.indexOf('function _stageDrawerHtml'), src.indexOf('function _stageFixHtml'));
  assert.match(drawer, /a\.needsLogin \|\| a\.sweepAction/,
    'both sending and monitoring login failures must use the same recovery UI');
  assert.match(drawer, /openProfileBrowser\('\$\{escHtml\(a\.profileId\)\}'\)/,
    'the button must open the selected account, never a campaign-level or guessed profile');
  assert.match(drawer, />Open GoLogin profile<\/button>/);
});
