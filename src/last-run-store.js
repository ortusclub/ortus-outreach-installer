// src/last-run-store.js
/**
 * Durable store for the campaign's last-run settings snapshot. The campaign
 * engine keeps the snapshot in memory (lost on process restart / monitoring
 * resume); this persists a copy so "Open" can rehydrate the wizard after the
 * starting process is gone. Pure I/O — no campaign import. Best-effort: every
 * read failure (missing / corrupt) returns null rather than throwing, so a bad
 * file never breaks the dashboard.
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

/** Read + parse the snapshot. Missing or corrupt file → null. */
export function readLastRun(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Atomically persist the snapshot (tmp file + rename). */
export function writeLastRun(filePath, snapshot) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  renameSync(tmp, filePath);
}
