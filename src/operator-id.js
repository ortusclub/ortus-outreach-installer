/**
 * Stable per-install operator identity.
 *
 * The scraper engine (scraper.ortusclub.com) is ONE shared service that every
 * colleague's app talks to. To keep each operator's Sales-Nav scrape jobs and
 * logs separate, the app tags every engine call with this id and filters
 * jobs/logs by it. The id is generated once and persisted to the per-user data
 * dir, so it's stable across restarts and unique per install.
 *
 * Read synchronously + cached: callers (scraper-client) are sync-friendly.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataPath } from './paths.js';

const ID_FILE = dataPath('operator-id.json');

let cached = null;

/** The stable operator id for this install (creates + persists it on first use). */
export function getOperatorId() {
  if (cached) return cached;
  try {
    const parsed = JSON.parse(readFileSync(ID_FILE, 'utf8'));
    if (parsed && typeof parsed.id === 'string' && parsed.id) {
      cached = parsed.id;
      return cached;
    }
  } catch { /* not created yet → fall through and generate */ }

  cached = `op_${randomUUID()}`;
  try {
    // Atomic write (tmp + rename) per repo convention.
    const tmp = `${ID_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ id: cached }, null, 2));
    renameSync(tmp, ID_FILE);
  } catch {
    // Best-effort persist. If the write fails we still return a usable id for
    // this process; it just won't survive a restart (rare, non-fatal).
    try { writeFileSync(ID_FILE, JSON.stringify({ id: cached }, null, 2)); } catch { /* */ }
  }
  return cached;
}
