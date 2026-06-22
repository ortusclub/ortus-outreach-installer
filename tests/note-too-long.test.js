import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoteOverFreeLimit } from '../src/linkedin/helpers.js';
import { normalizeSkipReason } from '../src/campaign.js';

// v2.112.x — free LinkedIn accounts cap custom-invite notes at 200 chars. A
// longer note leaves the connect modal's Send button DISABLED (the red
// "291/200" counter), so "clicking" it sends nothing and the old flow burned
// ~60s + 3 retries verifying a send that never happened. We detect the disabled
// Send + over-limit typed note up front and skip the lead with a clear flag.
// Premium accounts allow a longer note and keep Send ENABLED, so keying on the
// ACTUAL disabled state (not a hard-coded 200) means they are NOT mis-skipped.

test('free account, 291-char note, Send disabled → over limit', () => {
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: 291 }), true);
});

test('free account, short note (≤200), Send enabled → not over limit', () => {
  assert.equal(isNoteOverFreeLimit({ sendDisabled: false, typedLen: 150 }), false);
});

test('exactly 200 chars → allowed (200 is the cap, not over it)', () => {
  assert.equal(isNoteOverFreeLimit({ sendDisabled: false, typedLen: 200 }), false);
});

test('Premium account, 250-char note, Send ENABLED → not skipped', () => {
  // The whole point of keying on disabled state: Premium keeps Send enabled at
  // 250 chars, so we must let it send rather than mis-skip it.
  assert.equal(isNoteOverFreeLimit({ sendDisabled: false, typedLen: 250 }), false);
});

test('Send disabled but note short (≤200) → NOT classified as over-limit', () => {
  // A disabled Send with a short note is some OTHER block (empty field, a
  // transient pre-render). Don't mislabel it "note too long".
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: 12 }), false);
});

test('non-finite typed length → false (no signal)', () => {
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: NaN }), false);
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: undefined }), false);
});

test('no args → false (defensive)', () => {
  assert.equal(isNoteOverFreeLimit(), false);
});

test('custom freeLimit is respected (Premium ~300 cap)', () => {
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: 210, freeLimit: 300 }), false);
  assert.equal(isNoteOverFreeLimit({ sendDisabled: true, typedLen: 310, freeLimit: 300 }), true);
});

// normalizeSkipReason mapping — the operator's exact wording (2026-06-22).
test('NOTE_TOO_LONG maps to the not-premium custom-notes skip wording', () => {
  assert.equal(
    normalizeSkipReason('NOTE_TOO_LONG: note exceeds the free 200-char custom-note limit (account not Premium)'),
    'Skipped: Profile not premium, custom notes limit',
  );
});
