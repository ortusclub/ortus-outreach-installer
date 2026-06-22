import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlug } from '../../src/connections/slug.js';

test('extracts a vanity slug, lowercased', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/Elson-Chia'), 'elson-chia');
});
test('strips trailing slash and query', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/jolie-small-70bb7a11/?utm=x'), 'jolie-small-70bb7a11');
});
test('handles http, no-www', () => {
  assert.strictEqual(normalizeSlug('http://linkedin.com/in/yashdeshpande'), 'yashdeshpande');
});
test('decodes percent-escapes', () => {
  assert.strictEqual(
    normalizeSlug('https://www.linkedin.com/in/rafaelmu%C3%B1oztorres'), 'rafaelmuñoztorres');
});
test('returns null for sales-navigator and blanks', () => {
  assert.strictEqual(normalizeSlug('https://www.linkedin.com/sales/people/ACwAA,NAME_SEARCH'), null);
  assert.strictEqual(normalizeSlug(''), null);
  assert.strictEqual(normalizeSlug(null), null);
});
