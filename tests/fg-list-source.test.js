// Which source a launch request names, and what to do when it names none.
// The "none" case is the whole bug: today an absent source falls through to the
// roles builder and generates a list nobody asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveListSource } from '../src/connections/fg-list-launch.js';

test('a sheet URL is accepted and carried through', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=99' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'sheet');
  assert.equal(r.sheetUrl, 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=99');
});

test('a legacy central-sheet tab name still works', () => {
  // The builder door still writes a tab in the central FG sheet, and Auto-Pilot
  // fires through it. Removing this would break the 1st & 15th cron.
  const r = resolveListSource({ source: 'list', tab: 'FG List 2026-08-15' });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'tab');
  assert.equal(r.tab, 'FG List 2026-08-15');
});

test('a sheet URL wins when both are present', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit', tab: 'Old tab' });
  assert.equal(r.kind, 'sheet');
});

test('NO source is refused — it must never build a list', () => {
  for (const body of [{}, { source: '' }, { source: 'list' }, { source: 'list', sheetUrl: '   ' }, null]) {
    const r = resolveListSource(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.match(r.error, /choose where the list comes from/i);
  }
});

test('a URL that is not a Google Sheet is refused with a useful message', () => {
  const r = resolveListSource({ source: 'list', sheetUrl: 'https://example.com/not-a-sheet' });
  assert.equal(r.ok, false);
  assert.match(r.error, /Google Sheet/i);
});
