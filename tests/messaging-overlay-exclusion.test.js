/**
 * The invite flow must never touch LinkedIn's messaging overlay.
 *
 * 2026-08-10 incident: an operator left a chat bubble open on a profile page.
 * The connect-note flow found the chat composer before the invite modal's field,
 * typed the lead's note into it, and clicked the chat's "Send" — delivering a
 * note addressed to one person into a conversation with completely different
 * people, while the actual invitation was never created.
 *
 * isInMessagingOverlay() is the guard. It is mirrored inline inside the
 * page.evaluate callbacks in actions.js (browser context can't import modules) —
 * this test pins the behaviour both copies must have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isInMessagingOverlay, MESSAGING_OVERLAY_SELECTOR } from '../src/linkedin/helpers.js';

/** Minimal element stub: `closest` matches when the selector list names an ancestor class we carry. */
const el = (ancestors = []) => ({
  closest(selector) {
    const wanted = selector.split(',').map((s) => s.trim());
    return ancestors.some((a) => wanted.includes(a)) ? { tag: 'ancestor' } : null;
  },
});

test('a field inside the chat overlay is excluded', () => {
  assert.equal(isInMessagingOverlay(el(['.msg-form'])), true);
  assert.equal(isInMessagingOverlay(el(['.msg-overlay-list-bubble'])), true);
  assert.equal(isInMessagingOverlay(el(['.msg-overlay-conversation-bubble'])), true);
});

test('the invite modal is NOT excluded', () => {
  assert.equal(isInMessagingOverlay(el(['.artdeco-modal'])), false);
  assert.equal(isInMessagingOverlay(el([])), false);
});

test('a missing or malformed element never throws', () => {
  assert.equal(isInMessagingOverlay(null), false);
  assert.equal(isInMessagingOverlay(undefined), false);
  assert.equal(isInMessagingOverlay({}), false);
  assert.equal(isInMessagingOverlay({ closest() { throw new Error('bad selector'); } }), false);
});

test('the selector names every messaging-overlay container the invite flow can hit', () => {
  for (const sel of ['.msg-overlay-list-bubble', '.msg-form', '#msg-overlay']) {
    assert.ok(MESSAGING_OVERLAY_SELECTOR.includes(sel), `${sel} missing from the exclusion list`);
  }
});
