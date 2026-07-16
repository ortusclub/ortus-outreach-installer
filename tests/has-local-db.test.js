import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLocalDb } from '../src/connections/search-service.js';

test('hasLocalDb is true when the cache file exists, false when absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hld-'));
  const cachePath = path.join(dir, 'connections-cache.json');
  assert.equal(hasLocalDb({ cachePath }), false);
  fs.writeFileSync(cachePath, '{"contacts":[]}');
  assert.equal(hasLocalDb({ cachePath }), true);
});
