// The company page an FG run invites to. Picked from a dropdown in setup —
// never inferred from the login email or from which accounts were selected
// (Sam, 2026-08-10). Ortus is the default so doing nothing behaves as it
// always has.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FG_PAGES, FG_PAGE_LIST, pageById } from '../src/fg-pages.js';
import { ORTUS_PAGE_INVITE_URL } from '../src/sheets-webapp-url.js';

test('Ortus is the default and its URL is today\'s constant, verbatim', () => {
  // THE regression test. If this fails, an FG run is inviting to the wrong
  // page for every Ortus operator.
  assert.equal(pageById('ortus').inviteUrl, ORTUS_PAGE_INVITE_URL);
  assert.equal(FG_PAGE_LIST[0].id, 'ortus');
});

test('anything unrecognised falls back to Ortus', () => {
  for (const bad of ['', null, undefined, 'nonsense', 'APEX ', 42, {}]) {
    assert.equal(pageById(bad).id, 'ortus', String(bad));
    assert.equal(pageById(bad).inviteUrl, ORTUS_PAGE_INVITE_URL, String(bad));
  }
});

test('apex resolves to the Apex page', () => {
  assert.equal(pageById('apex').id, 'apex');
  assert.match(pageById('apex').inviteUrl, /apex-guesting-partner/);
});

test('every page URL has the shape that actually opens the invite modal', () => {
  // A bare /company/<slug>/ URL loads the page but not the modal.
  for (const p of FG_PAGE_LIST) {
    assert.match(p.inviteUrl, /^https:\/\/www\.linkedin\.com\/company\/[^/]+\/posts\/\?feedView=all&invite=true$/, p.id);
    assert.ok(p.label && p.label.trim(), `${p.id} needs a label`);
  }
});

test('FG_PAGE_LIST is FG_PAGES in order, with no duplicate ids', () => {
  const ids = FG_PAGE_LIST.map((p) => p.id);
  assert.deepEqual(ids, [...new Set(ids)]);
  assert.equal(ids.length, Object.keys(FG_PAGES).length);
});
