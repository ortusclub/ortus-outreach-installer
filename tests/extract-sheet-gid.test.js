import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSheetGid } from '../src/utils.js';

// extractSheetGid pulls the tab id from a Google Sheet URL. Google emits gid
// in three different shapes depending on how the link was generated:
//   - #gid=  (typical share link)
//   - ?gid=  (older view links)
//   - &gid=  (when combined with another query param)
// All three should match. Anything else returns '' and the caller falls back
// to the first tab.

test('extracts gid from #gid= fragment', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=987654321';
  assert.equal(extractSheetGid(url), '987654321');
});

test('extracts gid from ?gid= query', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc123/view?gid=42';
  assert.equal(extractSheetGid(url), '42');
});

test('extracts gid from &gid= when chained after another param', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing&gid=12345';
  assert.equal(extractSheetGid(url), '12345');
});

test('returns empty string when URL has no gid', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing';
  assert.equal(extractSheetGid(url), '');
});

test('returns empty string for empty / non-string input', () => {
  assert.equal(extractSheetGid(''), '');
  assert.equal(extractSheetGid(null), '');
  assert.equal(extractSheetGid(undefined), '');
  assert.equal(extractSheetGid(12345), '');
});

test('handles gid=0 (first tab) explicitly', () => {
  const url = 'https://docs.google.com/spreadsheets/d/abc123/edit#gid=0';
  assert.equal(extractSheetGid(url), '0');
});
