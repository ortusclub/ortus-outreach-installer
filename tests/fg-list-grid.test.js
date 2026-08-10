// fetchSheet() hands back one object per row keyed by header; parseListRows
// wants a 2-D grid with the header as row 0. This adapter is the join between
// them — get it wrong and every BYO sheet silently reads as empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gridFromSheetRows, parseListRows } from '../src/connections/fg-list.js';

test('builds a header row plus one array per record', () => {
  const grid = gridFromSheetRows([
    { 'LinkedIn URL': 'https://www.linkedin.com/in/ada', 'Account Email': 'a@x.com' },
    { 'LinkedIn URL': 'https://www.linkedin.com/in/bob', 'Account Email': 'b@x.com' },
  ]);
  assert.deepEqual(grid, [
    ['LinkedIn URL', 'Account Email'],
    ['https://www.linkedin.com/in/ada', 'a@x.com'],
    ['https://www.linkedin.com/in/bob', 'b@x.com'],
  ]);
});

test('column order comes from the FIRST row and later rows follow it', () => {
  // Object key order can differ per record; the grid must stay rectangular or
  // parseListRows reads values out of the wrong column.
  const grid = gridFromSheetRows([
    { A: '1', B: '2' },
    { B: '4', A: '3' },
  ]);
  assert.deepEqual(grid, [['A', 'B'], ['1', '2'], ['3', '4']]);
});

test('a key missing from a later row becomes an empty cell, not a hole', () => {
  const grid = gridFromSheetRows([{ A: '1', B: '2' }, { A: '3' }]);
  assert.deepEqual(grid, [['A', 'B'], ['1', '2'], ['3', '']]);
});

test('non-string cells are stringified, null/undefined become empty', () => {
  const grid = gridFromSheetRows([{ A: 1, B: null }, { A: undefined, B: false }]);
  assert.deepEqual(grid, [['A', 'B'], ['1', ''], ['', 'false']]);
});

test('empty input gives an empty grid, not a crash', () => {
  assert.deepEqual(gridFromSheetRows([]), []);
  assert.deepEqual(gridFromSheetRows(null), []);
  assert.deepEqual(gridFromSheetRows(undefined), []);
});

test('a row whose Account Email is unknown is reported, not silently dropped', () => {
  // An operator will typo a sending address. That row must come back in
  // `skipped` with the reason, or the run quietly invites fewer people than
  // the sheet says and nobody finds out.
  const { leads, skipped } = parseListRows(
    gridFromSheetRows([{ 'LinkedIn URL': 'https://www.linkedin.com/in/ada', 'Account Email': 'typo@x.com' }]),
    { emailToProfileId: { 'a@x.com': 'p1' } },
  );
  assert.equal(leads.length, 0);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /unknown account email/i);
  assert.equal(skipped[0].rowNumber, 2);
});

test('end to end: a two-column BYO sheet parses into routed leads', () => {
  // The whole point of the feature — an operator's own sheet with only the two
  // required columns, in their own words, must produce leads.
  const rows = [
    { 'Profile URL': 'https://www.linkedin.com/in/ada', 'Sending Account': 'a@x.com' },
    { 'Profile URL': 'https://www.linkedin.com/in/bob', 'Sending Account': 'b@x.com' },
  ];
  const { leads, skipped } = parseListRows(gridFromSheetRows(rows), {
    emailToProfileId: { 'a@x.com': 'p1', 'b@x.com': 'p2' },
  });
  assert.equal(skipped.length, 0);
  assert.equal(leads.length, 2);
  assert.deepEqual(leads.map((l) => l.routeAccount).sort(), ['p1', 'p2']);
});
