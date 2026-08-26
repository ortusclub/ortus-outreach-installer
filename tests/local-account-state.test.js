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
