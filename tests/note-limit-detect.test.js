import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isNoteLimitModalText } from '../src/linkedin/actions.js';

// LinkedIn's free accounts have a monthly cap on personalized (noted) invites.
// When exhausted, clicking "Add a note" shows this Premium upsell INSTEAD of the
// note field (real text captured 2026-06-22):
const OUT_OF_NOTES = `Send unlimited personalized invites with Premium
You're out of free custom notes. Bypass the limit with Premium, write longer notes, and make your profile stand out.
Plus unlock and message all your viewers
Try Premium for ₹0
1-month free trial with 24/7 support. We'll remind you 7 days before your trial ends.`;

test('isNoteLimitModalText: the real out-of-notes upsell → true', () => {
  assert.equal(isNoteLimitModalText(OUT_OF_NOTES), true);
  assert.equal(isNoteLimitModalText(OUT_OF_NOTES.toLowerCase()), true);
});

test('isNoteLimitModalText: matches on either signal phrase alone', () => {
  assert.equal(isNoteLimitModalText('blah out of free custom notes blah'), true);
  assert.equal(isNoteLimitModalText('Send unlimited personalized invites with Premium'), true);
});

test('isNoteLimitModalText: a normal Add-a-note modal → false', () => {
  assert.equal(isNoteLimitModalText('Add a note to your invitation. Include a personal message (optional).'), false);
});

test('isNoteLimitModalText: the weekly-invitation-limit modal → false (different cap)', () => {
  assert.equal(isNoteLimitModalText("You've reached the weekly invitation limit. Try again next week."), false);
});

test('isNoteLimitModalText: empty / nullish → false', () => {
  assert.equal(isNoteLimitModalText(''), false);
  assert.equal(isNoteLimitModalText(null), false);
  assert.equal(isNoteLimitModalText(undefined), false);
});
