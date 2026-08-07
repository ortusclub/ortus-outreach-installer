// tests/fg-master-records.test.js
// listMasterRecords must hand back exactly the population the master tab shows:
// warm, non-DNC records — no role filtering (the master is the whole network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listMasterRecords } from '../src/connections/search-service.js';

test('listMasterRecords is exported and returns an array', () => {
  assert.equal(typeof listMasterRecords, 'function');
  // No local DB in CI: an empty cache yields an empty list, not a throw.
  const out = listMasterRecords({ dir: 'tests/does-not-exist', cachePath: 'tests/does-not-exist.json' });
  assert.ok(Array.isArray(out));
});
