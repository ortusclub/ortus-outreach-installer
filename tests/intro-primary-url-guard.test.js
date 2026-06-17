import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkedInProfileUrl } from '../src/linkedin/auto-intro.js';

// v2.103 — the connect-to-primary gate should run only when the configured
// Primary URL is an actual LinkedIn profile. Operators sometimes paste a Google
// Sheet link (or leave a header label) in that field; loading it wastes a page
// navigation and reads garbage. Skip the check in those cases (intros proceed).

test('true for canonical LinkedIn profile URLs', () => {
  assert.equal(isLinkedInProfileUrl('https://www.linkedin.com/in/jane-doe/'), true);
  assert.equal(isLinkedInProfileUrl('linkedin.com/in/jane-doe'), true);
  assert.equal(isLinkedInProfileUrl('https://www.linkedin.com/in/ACwAAB1234'), true);
});

test('false for non-LinkedIn / non-profile values', () => {
  assert.equal(isLinkedInProfileUrl('https://docs.google.com/spreadsheets/d/abc'), false);
  assert.equal(isLinkedInProfileUrl('https://www.linkedin.com/company/ortus'), false);
  assert.equal(isLinkedInProfileUrl('Primary URL'), false);
  assert.equal(isLinkedInProfileUrl(''), false);
  assert.equal(isLinkedInProfileUrl(null), false);
});
