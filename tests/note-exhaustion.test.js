/**
 * Note-credit state for a sending session.
 *
 * 2026-08-10: stanley.o sent 5 personalised invites then its allowance ran out;
 * robert.junio had 3 left. Past that LinkedIn still renders "Add a note" but
 * produces no text box, and the app neither noticed nor reported it — 12 invites
 * went out bare and were logged as clean sends, and 5 more had their note typed
 * into an open chat window.
 *
 * Operator decision 2026-08-11: when the allowance is spent, keep sending WITHOUT
 * the note (it used to bench the account) — but never silently. getNoteState() is
 * how the campaign layer learns that, since performOutreach's return shape lives
 * in an off-limits file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getNoteState } from '../src/linkedin/actions.js';

test('an unseen session reports a clean, non-exhausted state', () => {
  const s = getNoteState({});
  assert.equal(s.exhausted, false);
  assert.equal(s.used, 0);
  assert.equal(s.detectedAt, null);
});

test('state is per-session, so one account running dry never mutes another', () => {
  const pageA = {};
  const pageB = {};
  assert.equal(getNoteState(pageA).exhausted, false);
  assert.equal(getNoteState(pageB).exhausted, false);
  assert.notEqual(getNoteState(pageA), getNoteState(pageB));
});

test('getNoteState returns a copy — a caller cannot flip the real flag', () => {
  const page = {};
  const s = getNoteState(page);
  s.exhausted = true;
  s.used = 99;
  assert.equal(getNoteState(page).exhausted, false, 'mutating the returned object must not reach the session');
  assert.equal(getNoteState(page).used, 0);
});

test('a session that never sent a note reports lastNoteIncluded undefined, not false', () => {
  // The campaign layer tests `=== false` precisely so "never ran" is not
  // mistaken for "note was dropped" and reported to the operator as a bare send.
  assert.notEqual(getNoteState({}).lastNoteIncluded, false);
});
