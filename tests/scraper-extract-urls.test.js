import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSalesNavUrls, extractSalesNavUrlsWithRows } from '../src/scraper-client.js';

// Rows mirror what fetchSheet returns: array of objects keyed by column header.

test('extracts Sales Nav search URLs from any column', () => {
  const rows = [
    { 'Search URL': 'https://www.linkedin.com/sales/search/people?query=a' },
    { 'Search URL': 'https://www.linkedin.com/sales/search/people?query=b' },
  ];
  assert.deepEqual(extractSalesNavUrls(rows), [
    'https://www.linkedin.com/sales/search/people?query=a',
    'https://www.linkedin.com/sales/search/people?query=b',
  ]);
});

test('ignores non-Sales-Nav cells (profile URLs, names, blanks)', () => {
  const rows = [
    { url: 'https://www.linkedin.com/in/john-doe', name: 'John Doe' },
    { url: 'https://www.linkedin.com/sales/search/people?q=x', name: 'keep me' },
    { url: '', name: '' },
  ];
  assert.deepEqual(extractSalesNavUrls(rows), ['https://www.linkedin.com/sales/search/people?q=x']);
});

test('trims whitespace and dedupes, preserving first-seen order', () => {
  const rows = [
    { a: '  https://www.linkedin.com/sales/search/people?q=1  ' },
    { a: 'https://www.linkedin.com/sales/search/people?q=2' },
    { a: 'https://www.linkedin.com/sales/search/people?q=1' },
  ];
  assert.deepEqual(extractSalesNavUrls(rows), [
    'https://www.linkedin.com/sales/search/people?q=1',
    'https://www.linkedin.com/sales/search/people?q=2',
  ]);
});

test('matches company search and http/scheme-less variants too', () => {
  const rows = [
    { a: 'http://www.linkedin.com/sales/search/company?q=c' },
    { a: 'linkedin.com/sales/search/people?q=d' },
  ];
  assert.deepEqual(extractSalesNavUrls(rows), [
    'http://www.linkedin.com/sales/search/company?q=c',
    'linkedin.com/sales/search/people?q=d',
  ]);
});

test('empty / non-array input → []', () => {
  assert.deepEqual(extractSalesNavUrls([]), []);
  assert.deepEqual(extractSalesNavUrls(null), []);
  assert.deepEqual(extractSalesNavUrls(undefined), []);
});

// ─── row-aware variant (powers the "scrape rows 2–10" picker) ───────────────
// Input mirrors fetchSheetWithRows: [{ rowNumber, row }] with TRUE sheet rows.

test('withRows: tags each URL with its sheet row number', () => {
  const rows = [
    { rowNumber: 2, row: { 'Search URL': 'https://www.linkedin.com/sales/search/people?q=a' } },
    { rowNumber: 3, row: { 'Search URL': 'https://www.linkedin.com/sales/search/people?q=b' } },
  ];
  assert.deepEqual(extractSalesNavUrlsWithRows(rows), [
    { row: 2, url: 'https://www.linkedin.com/sales/search/people?q=a' },
    { row: 3, url: 'https://www.linkedin.com/sales/search/people?q=b' },
  ]);
});

test('withRows: preserves non-contiguous sheet rows; skips rows with no search', () => {
  // Row 4 (a profile URL) is skipped; the row NUMBERS of later rows are kept
  // exactly as the sheet has them (4 missing → 2, 3, 5, 7).
  const rows = [
    { rowNumber: 2, row: { a: 'https://www.linkedin.com/sales/search/people?q=1' } },
    { rowNumber: 3, row: { a: 'https://www.linkedin.com/sales/search/people?q=2' } },
    { rowNumber: 4, row: { a: 'https://www.linkedin.com/in/john-doe' } },
    { rowNumber: 5, row: { a: 'https://www.linkedin.com/sales/search/people?q=3' } },
    { rowNumber: 7, row: { a: 'https://www.linkedin.com/sales/search/people?q=4' } },
  ];
  assert.deepEqual(extractSalesNavUrlsWithRows(rows).map((i) => i.row), [2, 3, 5, 7]);
});

test('withRows: one search per row (first match), does NOT dedupe across rows', () => {
  const rows = [
    { rowNumber: 2, row: { a: 'https://www.linkedin.com/sales/search/people?q=dup', b: 'https://www.linkedin.com/sales/search/people?q=second' } },
    { rowNumber: 3, row: { a: 'https://www.linkedin.com/sales/search/people?q=dup' } },
  ];
  // Row 2 keeps only its first match; the duplicate URL on row 3 is preserved
  // (each row is an independently pickable unit).
  assert.deepEqual(extractSalesNavUrlsWithRows(rows), [
    { row: 2, url: 'https://www.linkedin.com/sales/search/people?q=dup' },
    { row: 3, url: 'https://www.linkedin.com/sales/search/people?q=dup' },
  ]);
});

test('withRows: empty / non-array input → []', () => {
  assert.deepEqual(extractSalesNavUrlsWithRows([]), []);
  assert.deepEqual(extractSalesNavUrlsWithRows(null), []);
  assert.deepEqual(extractSalesNavUrlsWithRows(undefined), []);
});
