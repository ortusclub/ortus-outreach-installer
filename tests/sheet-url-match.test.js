import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLeadUrl, matchingRowNumbers } from '../src/sheet-url-match.js';

// ─── normalizeLeadUrl: loose identity (v2.105) ───────────────────────────────
// The sheet writer must resolve the SAME person to one identity regardless of
// protocol, www, query string, fragment, trailing slash, or case. Otherwise a
// "Connection Request Sent" stamp and a "Still Pending" stamp can land on what
// look like different rows for the same lead.

test('normalizeLeadUrl strips protocol, www, query, fragment, trailing slash, case', () => {
  const a = normalizeLeadUrl('https://www.linkedin.com/in/jane-doe/?utm_source=x#foo');
  const b = normalizeLeadUrl('http://linkedin.com/in/jane-doe');
  const c = normalizeLeadUrl('LINKEDIN.COM/IN/JANE-DOE/');
  assert.equal(a, 'linkedin.com/in/jane-doe');
  assert.equal(b, 'linkedin.com/in/jane-doe');
  assert.equal(c, 'linkedin.com/in/jane-doe');
});

test('normalizeLeadUrl returns empty string for falsy input', () => {
  assert.equal(normalizeLeadUrl(''), '');
  assert.equal(normalizeLeadUrl(null), '');
  assert.equal(normalizeLeadUrl(undefined), '');
});

// ─── matchingRowNumbers: stamp EVERY copy (v2.105) ───────────────────────────

test('returns ALL rows for an identical duplicate (the 109/110 case)', () => {
  const cells = [
    'https://www.linkedin.com/in/jane-doe',   // row 2
    'https://www.linkedin.com/in/jane-doe',   // row 3  (identical dup)
    'https://www.linkedin.com/in/someone-else',
  ];
  assert.deepEqual(matchingRowNumbers(cells, 'https://www.linkedin.com/in/jane-doe'), [2, 3]);
});

test('matches duplicate copies that differ only by protocol/www/query', () => {
  const cells = [
    'http://linkedin.com/in/jane-doe/',                  // row 2
    'https://www.linkedin.com/in/jane-doe?trk=abc',      // row 3
    'https://www.linkedin.com/in/jane-doe',              // row 4
  ];
  assert.deepEqual(matchingRowNumbers(cells, 'linkedin.com/in/jane-doe'), [2, 3, 4]);
});

test('does NOT conflate different people', () => {
  const cells = [
    'https://www.linkedin.com/in/jane-doe',
    'https://www.linkedin.com/in/jane-doe-2',
  ];
  assert.deepEqual(matchingRowNumbers(cells, 'https://www.linkedin.com/in/jane-doe'), [2]);
});

test('falls back to /in/<slug> contains-match when no exact normalized match', () => {
  const cells = [
    'https://www.linkedin.com/in/jane-doe?originalSubdomain=uk',
    'random text linkedin.com/in/jane-doe extra',
  ];
  // bare slug search, cells have trailing junk → exact fails, slug fallback finds both
  assert.deepEqual(matchingRowNumbers(cells, 'jane-doe'), [2, 3]);
});

test('returns [] when the lead is not present', () => {
  const cells = ['https://www.linkedin.com/in/jane-doe'];
  assert.deepEqual(matchingRowNumbers(cells, 'https://www.linkedin.com/in/nobody'), []);
});

test('returns [] for empty search url', () => {
  assert.deepEqual(matchingRowNumbers(['https://www.linkedin.com/in/jane-doe'], ''), []);
});
