import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSalesNavUrls } from '../src/scraper-client.js';

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
