import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinkedInUrl } from '../src/campaign.js';

// Pure helper — extracts a LinkedIn URL from a sheet row object.
// 1. Named column takes priority if it contains linkedin.com or a slug.
// 2. Falls back to scanning all columns for any value containing linkedin.com.
// 3. Returns null when no URL is found.

test('finds URL in explicit column when linkedinColumn provided', () => {
  const row = { LinkedIn: 'https://www.linkedin.com/in/jane-doe', Name: 'Jane' };
  const url = extractLinkedInUrl(row, 'LinkedIn');
  assert.equal(url, 'https://www.linkedin.com/in/jane-doe');
});

test('auto-detects URL when linkedinColumn is empty string', () => {
  const row = { Name: 'Jane', Profile: 'https://www.linkedin.com/in/jane-doe' };
  const url = extractLinkedInUrl(row, '');
  assert.equal(url, 'https://www.linkedin.com/in/jane-doe');
});

test('returns null when no URL anywhere', () => {
  const row = { Name: 'Jane', Email: 'jane@example.com' };
  const url = extractLinkedInUrl(row, '');
  assert.equal(url, null);
});

test('returns company page URL when only linkedin.com/company path present', () => {
  // Fallback scan matches anything containing linkedin.com — no /in/ filter.
  const row = { Name: 'Jane', Site: 'https://www.linkedin.com/company/foo' };
  const url = extractLinkedInUrl(row, '');
  assert.equal(url, 'https://www.linkedin.com/company/foo');
});

test('prepends https:// to bare linkedin.com URL in named column', () => {
  const row = { LinkedIn: 'linkedin.com/in/jane', Name: 'Jane' };
  const url = extractLinkedInUrl(row, 'LinkedIn');
  assert.equal(url, 'https://linkedin.com/in/jane');
});

test('converts slug in named column to full URL', () => {
  // Value has no space, no @, no linkedin.com — treated as slug → /in/ path.
  const row = { LinkedIn: 'jane-doe-123', Name: 'Jane' };
  const url = extractLinkedInUrl(row, 'LinkedIn');
  assert.equal(url, 'https://www.linkedin.com/in/jane-doe-123');
});
