import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmFingerprint } from '../src/dm-sent-log.js';

test('dmFingerprint: identical messages → identical fingerprint', () => {
  const a = dmFingerprint('Hi Milena, how are you? My name is Antonio.');
  const b = dmFingerprint('Hi Milena, how are you? My name is Antonio.');
  assert.equal(a, b);
});

test('dmFingerprint: different messages → different fingerprint', () => {
  const a = dmFingerprint('Hi Milena, how are you?');
  const b = dmFingerprint('Hi Milena, hope you are well!');
  assert.notEqual(a, b);
});

test('dmFingerprint: trivial whitespace (CRLF, trailing) is normalized', () => {
  const a = dmFingerprint('Hi Milena.\nHow are you?');
  const b = dmFingerprint('  Hi Milena.\r\nHow are you?  ');
  assert.equal(a, b);
});

test('dmFingerprint: a changed word is NOT a match (template edited → resend)', () => {
  const original = dmFingerprint('Hi Milena, my name is Antonio.');
  const edited   = dmFingerprint('Hi Milena, my name is Sam.');
  assert.notEqual(original, edited);
});
