import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { ingestFolder } from '../../src/connections/csv-ingest.js';

test('ingests a folder into a slug index with stats', () => {
  const { index, stats } = ingestFolder(path.join(__dirname, 'fixtures'));
  assert.strictEqual(stats.files, 1);
  assert.strictEqual(stats.withUrl, 3);        // 3 rows have a URL
  assert.strictEqual(stats.skippedNoUrl, 1);   // the redacted row
  assert.strictEqual(index.size, 3);
  assert.deepStrictEqual(index.get('elson-chia'), [{ colleague: 'sample', connectedOn: '16 Oct 2025' }]);
  assert.ok(index.has('harry-c-574ab513'));    // quoted-comma name parsed correctly
});
