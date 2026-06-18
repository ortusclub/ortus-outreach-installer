import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowNoteHint } from '../public/js/note-hint.mjs';

test('shouldShowNoteHint is false for empty / whitespace / non-string', () => {
  assert.equal(shouldShowNoteHint(''), false);
  assert.equal(shouldShowNoteHint('   '), false);
  assert.equal(shouldShowNoteHint('\n\t'), false);
  assert.equal(shouldShowNoteHint(undefined), false);
  assert.equal(shouldShowNoteHint(null), false);
});

test('shouldShowNoteHint is true when the note has visible text', () => {
  assert.equal(shouldShowNoteHint('Hi there'), true);
  assert.equal(shouldShowNoteHint('  hi  '), true);
});
