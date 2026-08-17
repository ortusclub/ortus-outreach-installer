// The replacement campaign's name. Four campaigns off one list (CC_I → CC_J →
// CC_K → CC_L) is what an un-suffixed replacement looks like from the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextReplacementName } from '../public/js/replacement-name.mjs';

test('a first replacement gets (2)', () => {
  assert.equal(nextReplacementName('PRIMO_I CC_J'), 'PRIMO_I CC_J (2)');
});

test('replacing a replacement keeps counting, it does not nest', () => {
  assert.equal(nextReplacementName('PRIMO_I CC_J (2)'), 'PRIMO_I CC_J (3)');
  assert.equal(nextReplacementName('PRIMO_I CC_J (9)'), 'PRIMO_I CC_J (10)');
});

test("an operator's own trailing number is not mistaken for our counter", () => {
  // "Batch (1)" is a name someone chose. Continuing it as (2) would be a guess
  // about their scheme; starting our own chain at (2) is the honest read either
  // way, and never collides with the campaign it replaces.
  assert.equal(nextReplacementName('Batch (1)'), 'Batch (2)');
});

test('a blank name returns blank so the caller keeps what the wizard holds', () => {
  assert.equal(nextReplacementName(''), '');
  assert.equal(nextReplacementName('   '), '');
  assert.equal(nextReplacementName(null), '');
  assert.equal(nextReplacementName(undefined), '');
});

test('surrounding whitespace never leaks into the suffix', () => {
  assert.equal(nextReplacementName('  CC_J  '), 'CC_J (2)');
  assert.equal(nextReplacementName('CC_J  (2)  '), 'CC_J (3)');
});

test('a parenthesised word is left alone — only a trailing counter counts', () => {
  assert.equal(nextReplacementName('CC_J (APAC)'), 'CC_J (APAC) (2)');
});
