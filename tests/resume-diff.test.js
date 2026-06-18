// tests/resume-diff.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSheetDiff } from '../src/resume-diff.js';

const urlOf = (row) => row.url;

test('computeSheetDiff: new URLs are added, sent/identical untouched', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', name: 'A' }];
  const next = [
    { url: 'https://linkedin.com/in/a', name: 'A' },
    { url: 'https://linkedin.com/in/b', name: 'B' },
  ];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 1);
  assert.equal(d.added[0].url, 'https://linkedin.com/in/b');
  assert.equal(d.updatedCount, 0);
  assert.equal(d.newTotal, 2);
});

test('computeSheetDiff: same URL with changed cell values is an update', () => {
  const prev = [{ url: 'https://linkedin.com/in/a', title: 'CEO' }];
  const next = [{ url: 'https://linkedin.com/in/a', title: 'Founder' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 1);
  assert.equal(d.updatedPending[0].title, 'Founder');
});

test('computeSheetDiff: URL normalization (trailing slash / query / case)', () => {
  const prev = [{ url: 'https://linkedin.com/in/a' }];
  const next = [{ url: 'https://linkedin.com/in/A/?utm=x' }];
  const d = computeSheetDiff(prev, next, urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.updatedCount, 0);
});

test('computeSheetDiff: rows without a URL are ignored', () => {
  const d = computeSheetDiff([], [{ url: '' }, { url: null }], urlOf);
  assert.equal(d.addedCount, 0);
  assert.equal(d.newTotal, 2);
});
