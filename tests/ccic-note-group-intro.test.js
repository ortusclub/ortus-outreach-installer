import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _decideIntroPath, _groupHasHistory } from '../src/linkedin/auto-intro.js';

// ── Note-aware intro routing ──
// Clean-compose (typeahead both pills into a blank box → real group) is used ONLY
// when a connection note created a prior 1:1 thread AND we have the lead's full
// name to typeahead. Everything else keeps the unchanged URL-routing path.

test('note + lead name → clean-compose', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: true, leadFullName: 'Angelo Cruz' }), 'clean-compose');
});

test('note + missing lead name → url-routing fallback', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: true, leadFullName: '' }), 'url-routing');
});

test('note + whitespace-only lead name → url-routing fallback', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: true, leadFullName: '   ' }), 'url-routing');
});

test('no note → url-routing (unchanged path) even with a name', () => {
  assert.equal(_decideIntroPath({ hasConnectionNote: false, leadFullName: 'Angelo Cruz' }), 'url-routing');
});

// ── Dedupe probe decision ──
// Any rendered message event in the group compose means a thread for this
// lead+primary already exists → already introduced.

test('_groupHasHistory: 0 events → empty group → send', () => {
  assert.equal(_groupHasHistory(0), false);
});

test('_groupHasHistory: any events → already exists', () => {
  assert.equal(_groupHasHistory(3), true);
  assert.equal(_groupHasHistory(1), true);
});
