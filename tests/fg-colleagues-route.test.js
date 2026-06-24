import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRolesParam } from '../src/connections/search-service.js';

test('parseRolesParam splits, trims, lowercases, drops empties', () => {
  assert.deepEqual(parseRolesParam('Marketing, Brand ,, growth'), ['marketing', 'brand', 'growth']);
});

test('parseRolesParam returns [] for undefined/empty', () => {
  assert.deepEqual(parseRolesParam(undefined), []);
  assert.deepEqual(parseRolesParam(''), []);
});
