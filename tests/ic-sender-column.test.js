import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// app.js is a browser bundle with no exports, so these are source assertions —
// same approach as mode-locks.test.js / retired-modes.test.js.
//
// Both bugs below were reported together on 20 Aug 2026: an IC campaign hit
// "No sender column selected" on a sheet that clearly had the senders in it,
// and Section 2 showed no picker to fix it with.
const APP = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

test('startNewCampaign resets the IC picker by class, never inline display', () => {
  // An inline display:none outranks previewSheet()'s classList.remove('hidden'),
  // so the picker could never come back in that session.
  assert.equal(
    /_icExtrasFilled\.style\.display = 'none'/.test(APP),
    false,
    'inline display:none on #ic-extras-filled pins the picker hidden forever',
  );
  assert.match(APP, /_icExtrasFilled\.classList\.add\('hidden'\)/);
  assert.match(APP, /_icExtrasEmpty\.classList\.remove\('hidden'\)/);
});

test('sender auto-detect refuses a header match with no values', () => {
  // Ortus sheets carry a legacy blank `Sender` column, and 'sender' is first in
  // SENDER_HEADER_PRIORITY — without the value check it wins over the column
  // that actually holds the 1st connections.
  assert.match(APP, /const _colHasValues = \(col\) => \{/);
  assert.match(APP, /found !== autoDetectCol && _colHasValues\(found\)/);
});

test('the preflight modal button skips a picker that is still hidden', () => {
  assert.match(APP, /if \(!sel \|\| \(filled && filled\.classList\.contains\('hidden'\)\)\)/);
});
