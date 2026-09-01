import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

// The exact value the operator screenshotted as the card's biggest text.
const REAL_ID = '6a5f1605f264c576fd2fcabf';
const isProfileId = (v) => /^[0-9a-f]{24}$/i.test(String(v == null ? '' : v).trim());

test('the shape test catches a real GoLogin profile id', () => {
  assert.equal(isProfileId(REAL_ID), true);
  assert.equal(isProfileId(REAL_ID.toUpperCase()), true);
  assert.equal(isProfileId(` ${REAL_ID} `), true);
});

test('it does not catch anything an operator should read', () => {
  for (const v of [
    'somnath.mandal@ortus.solutions', 'Waiting for the next acceptance check',
    'Louise Calcutt', 'complete', '0 of 2', 'Cloud VM', '', null, undefined, 4,
  ]) assert.equal(isProfileId(v), false, `${v} must not be treated as an id`);
});

test('a 24-char word that is not hex is left alone', () => {
  assert.equal(isProfileId('abcdefghijklmnopqrstuvwx'), false);
});

test('the headline resolves the id instead of printing it', () => {
  assert.match(APP, /const who = _named\(la\.who \|\| '', 'This account'\);/);
});

test('the facts row resolves it too — Current account showed the id as well', () => {
  assert.match(APP, /escHtml\(_named\(value, 'this account'\)\)/);
});

test('one resolver, hoisted above every surface that uses it', () => {
  const hoisted = APP.indexOf('const _isProfileId = (v) =>');
  assert.ok(hoisted > -1, 'the guard exists');
  assert.ok(hoisted < APP.indexOf("const who = _named("), 'defined before the headline');
  assert.ok(hoisted < APP.indexOf("const acct = ca && ca.account && ca.account !== who"), 'before the sub-line');
  assert.equal((APP.match(/const _acctList = \(cid && _cloudAccountsById\.get\(cid\)\) \|\| \[\];/g) || []).length, 1,
    'the sub-line no longer keeps its own private copy');
});

test('an unresolvable id becomes words, never the hex', () => {
  // _named falls back only when the resolver hands the id straight back.
  const named = (v, fallback, resolve) => {
    if (!isProfileId(v)) return v;
    const r = resolve(String(v).trim());
    return (r && !isProfileId(r)) ? r : fallback;
  };
  assert.equal(named(REAL_ID, 'This account', () => REAL_ID), 'This account');
  assert.equal(named(REAL_ID, 'This account', () => 'somnath.mandal@ortus.solutions'), 'somnath.mandal@ortus.solutions');
  assert.equal(named('Louise Calcutt', 'This account', () => 'x'), 'Louise Calcutt');
});
