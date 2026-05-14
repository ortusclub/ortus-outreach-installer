/**
 * Test mode persistence — sync read for hot-path callers, async write for the
 * toggle endpoint. The file is small and read often; cache the value with a
 * short TTL (1 second) so we don't hit disk every interval check.
 *
 * Used by monitoring-time.js + post-campaign-bulk-check.js to compress the
 * 6-hour bulk-check schedule to 60 seconds during dev/manual testing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_MODE_FILE = process.env.ORTUS_DATA_DIR
  ? join(process.env.ORTUS_DATA_DIR, 'test-mode.json')
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'test-mode.json');

let _cache = null;
let _cacheUntil = 0;

export function isTestModeOn() {
  const now = Date.now();
  if (_cache !== null && now < _cacheUntil) return _cache;
  try {
    if (!existsSync(TEST_MODE_FILE)) {
      _cache = false;
    } else {
      const raw = readFileSync(TEST_MODE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      _cache = !!parsed?.on;
    }
  } catch {
    _cache = false;
  }
  _cacheUntil = now + 1000; // 1 second TTL
  return _cache;
}

export function setTestMode(on) {
  try {
    mkdirSync(dirname(TEST_MODE_FILE), { recursive: true });
  } catch { /* dir already exists */ }
  const payload = JSON.stringify({ on: !!on, updatedAt: new Date().toISOString() }, null, 2);
  const tmp = `${TEST_MODE_FILE}.tmp`;
  writeFileSync(tmp, payload, 'utf8');
  // Atomic rename for safety against partial writes.
  renameSync(tmp, TEST_MODE_FILE);
  _cache = !!on;
  _cacheUntil = Date.now() + 1000;
}
