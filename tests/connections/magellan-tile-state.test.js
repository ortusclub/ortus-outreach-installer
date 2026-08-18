import test from 'node:test';
import assert from 'node:assert/strict';
import { tileState } from '../../public/js/magellan-view.mjs';

const acc = (over = {}) => ({ account: 'a@ortus.solutions', resolved: true, importable: true, collected: false, ...over });

test('resolved and importable is the ordinary state', () => {
  assert.equal(tileState(acc({ collected: true })).kind, 'ready');
  assert.equal(tileState(acc({ collected: true })).word, 'DONE');
  assert.equal(tileState(acc({ collected: false })).word, 'TO DO');
});

test('not importable is fixable, and amber', () => {
  const s = tileState(acc({ importable: false }));
  assert.equal(s.kind, 'fixable');
  assert.equal(s.band, 's-fixable');
  assert.equal(s.tone, 'amber');
});

test('no SoO email beats not-importable — it is a dead end, not a button', () => {
  const s = tileState(acc({ resolved: false, importable: false }));
  assert.equal(s.kind, 'nosoo');
  assert.equal(s.tone, 'red');
});

test('no SoO email beats importable true as well', () => {
  assert.equal(tileState(acc({ resolved: false, importable: true })).kind, 'nosoo');
});

test('importable null is its own state, never green', () => {
  const s = tileState(acc({ importable: null }));
  assert.equal(s.kind, 'unknown');
  assert.notEqual(s.tone, 'green');
});

test('collected is irrelevant to which state wins', () => {
  assert.equal(tileState(acc({ importable: false, collected: true })).kind, 'fixable');
  assert.equal(tileState(acc({ importable: false, collected: false })).kind, 'fixable');
});
